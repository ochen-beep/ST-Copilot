import { DEFAULT_SYSTEM_PROMPT, EXT_DISPLAY } from '.././constants.js';
import { state, invalidateSystemPromptCache, decideSystemPromptCache } from '.././state.js';
import { getEffectiveSettings, getCurrentSession, saveSessionsToMetadata, addMessage } from '.././session.js';
import { _dbgAdd } from '.././utils/util-debug.js';
import { escHtml } from '.././utils/util-dom.js';
import { _ensureWrapped, normalizeCharNamesInBlock } from '.././utils/util-text.js';
import { cacheKey, fnv1a32 } from '.././utils/util-hash.js';
import { getCharInfo, getUserPersona, getGenStamp } from '.././utils/util-st.js';
import { recordStat, SM } from '.././features/feature-stats.js';
import { _mergeContent } from '.././features/feature-attachments.js';

import { _getAspectEvolutiaPersonaFields } from '.././integrations/integ-evolutia.js';
import { _getSummaryceptionSummary } from '.././integrations/integ-summaryception.js';
import { applyRegexIfEnabled } from '.././integrations/integ-regex.js';

import { buildLorebookContextBlock, buildLBAIInstructions, expandOutletsAsync } from '.././features/feature-lorebook-engine.js';
import { buildCharacterContextBlock, buildCharEditAIInstructions } from '.././features/feature-character-engine.js';
import { buildChatEditAIInstructions } from '.././features/feature-chatedit-engine.js';
import { buildMemoryContextBlock, buildMemoryAIInstructions, processMemoryUpdates, stripMemoryBlock } from '.././features/feature-memory.js';
import { buildToolCallsSystemBlock, parseToolCallsFromText, stripToolCallsFromText, executeTool, getEnabledTools, toOpenAITools, extractProviderToolCalls, findToolCallCut } from '.././features/feature-tools-engine.js';

import { updateMsgCount, smartScrollToBottom, setGeneratingState, showGenerationError, _renderMsgBodyContent, _refreshSwipeBars, appendMsgEl } from '.././ui/ui-chat.js';
import { getDisplayContent, extractToolCallPlaceholders, renderMarkdown, postProcessHTMLBlocks } from '.././ui/ui-chat.js';
import { createStreamRenderer } from '.././ui/render/stream-renderer.js';
import { postProcessToolCalls, executeAskUser } from '.././features/feature-tools-ui.js';
import { playCompletionSound } from '.././ui/ui-widgets.js';

// ─── Журнал «последних отправленных» запросов (инспектор) ───
// Ключи с секретами вымываются по имени поля; длинные строки (base64-вложения)
// схлопываются в размер. Ключи API ST живут в заголовках — сюда они не попадают,
// регулярка подстраховывает custom-эндпоинты.
const _SECRET_KEY_RE = /pass(word)?$|password|secret|(^|_)token$|api[_-]?key|authorization/i;

export function redactRequestBody(v, depth = 0) {
    if (v == null || depth > 8) return v;
    if (typeof v === 'string') {
        return v.length > 4000 ? `… (${Math.round(v.length / 1024)} KB)` : v;
    }
    if (Array.isArray(v)) return v.map(x => redactRequestBody(x, depth + 1));
    if (typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = _SECRET_KEY_RE.test(k) ? '***REDACTED***' : redactRequestBody(val, depth + 1);
        }
        return out;
    }
    return v;
}

export function logOutgoingRequest(url, body) {
    try {
        state.requestLog.push({ ts: Date.now(), url: String(url).split('?')[0].slice(0, 200), body: redactRequestBody(body) });
        if (state.requestLog.length > 5) state.requestLog.shift();
    } catch (_) {}
}

// ни попадать в журнал инспектора, ни получать переписанное тело.
const _GEN_BACKEND_RE = /\/api\/backends\/(chat-completions|text-completions)\/(generate|caption-image)(?:\?|$)/;

let _fetchPatchDepth = 0;
let _fetchPatchOrig = null;

export function _patchFetchForGeneration() {
    if (_fetchPatchDepth++ > 0) return; // внешний вызов уже пропатчил
    _fetchPatchOrig = window.fetch;
    window.fetch = async function(...args) {
        const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        if (_GEN_BACKEND_RE.test(requestUrl) && args[1] && typeof args[1].body === 'string') {
            try {
                let reqBody = JSON.parse(args[1].body);
                logOutgoingRequest(requestUrl, reqBody);
                let changed = false;

                if (reqBody.reasoning_effort === 'auto') { delete reqBody.reasoning_effort; changed = true; }
                else if (reqBody.reasoning_effort === 'min') { reqBody.reasoning_effort = 'low'; changed = true; }
                else if (reqBody.reasoning_effort === 'max') { reqBody.reasoning_effort = 'high'; changed = true; }

                if (reqBody.reasoning && typeof reqBody.reasoning === 'object') {
                    if (reqBody.reasoning.effort === 'auto') { delete reqBody.reasoning.effort; changed = true; }
                    else if (reqBody.reasoning.effort === 'min') { reqBody.reasoning.effort = 'low'; changed = true; }
                    else if (reqBody.reasoning.effort === 'max') { reqBody.reasoning.effort = 'high'; changed = true; }
                }

                if (reqBody.custom_prompt_post_processing === '') { delete reqBody.custom_prompt_post_processing; changed = true; }
                if (reqBody.request_image_resolution === '') { delete reqBody.request_image_resolution; changed = true; }
                if (reqBody.request_image_aspect_ratio === '') { delete reqBody.request_image_aspect_ratio; changed = true; }

                if (reqBody.chat_completion_source === 'zai' || (typeof reqBody.model === 'string' && reqBody.model.toLowerCase().includes('glm'))) {
                    if (reqBody.reasoning_effort !== undefined) { delete reqBody.reasoning_effort; changed = true; }
                    if (reqBody.reasoning !== undefined) { delete reqBody.reasoning; changed = true; }
                    if (Array.isArray(reqBody.messages)) {
                        reqBody.messages.forEach(m => { if (m.name !== undefined) { delete m.name; changed = true; } });
                    }
                }

                if (changed) args[1].body = JSON.stringify(reqBody);
            } catch(_) {}
        }
        return _fetchPatchOrig.apply(this, args);
    };
}

export function _unpatchFetchForGeneration() {
    if (--_fetchPatchDepth > 0) return;
    _fetchPatchDepth = 0;
    if (_fetchPatchOrig) {
        window.fetch = _fetchPatchOrig;
        _fetchPatchOrig = null;
    }
}

// ask_user ждёт живого человека: без внешних гвардов неотправленный ответ или
// чат-свитч оставляли runGenerate висеть навсегда с залипшим state.generating.
const ASK_USER_TIMEOUT_MS = 300000;

