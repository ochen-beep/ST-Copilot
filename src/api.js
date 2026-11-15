import { DEFAULT_SYSTEM_PROMPT, EXT_DISPLAY } from './constants.js';
import { state, invalidateSystemPromptCache, decideSystemPromptCache } from './state.js';
import { getEffectiveSettings, getCurrentSession, saveSessionsToMetadata, addMessage } from './session.js';
import { _dbgAdd } from './utils/util-debug.js';
import { escHtml } from './utils/util-dom.js';
import { _ensureWrapped, normalizeCharNamesInBlock } from './utils/util-text.js';
import { cacheKey, fnv1a32 } from './utils/util-hash.js';
import { getCharInfo, getUserPersona, getGenStamp } from './utils/util-st.js';
import { recordStat, SM } from './features/feature-stats.js';
import { _mergeContent } from './features/feature-attachments.js';

import { _getAspectEvolutiaPersonaFields } from './integrations/integ-evolutia.js';
import { _getSummaryceptionSummary } from './integrations/integ-summaryception.js';
import { applyRegexIfEnabled } from './integrations/integ-regex.js';

import { buildLorebookContextBlock, buildLBAIInstructions, expandOutletsAsync } from './features/feature-lorebook-engine.js';
import { buildCharacterContextBlock, buildCharEditAIInstructions } from './features/feature-character-engine.js';
import { buildChatEditAIInstructions } from './features/feature-chatedit-engine.js';
import { buildMemoryContextBlock, buildMemoryAIInstructions, processMemoryUpdates, stripMemoryBlock } from './features/feature-memory.js';
import { buildToolCallsSystemBlock, parseToolCallsFromText, stripToolCallsFromText, executeTool, getEnabledTools, toOpenAITools, extractProviderToolCalls, findToolCallCut } from './features/feature-tools-engine.js';

import { updateMsgCount, smartScrollToBottom, setGeneratingState, showGenerationError, _renderMsgBodyContent, _refreshSwipeBars, appendMsgEl } from './ui/ui-chat.js';
import { getDisplayContent, extractToolCallPlaceholders, renderMarkdown, postProcessHTMLBlocks } from './ui/ui-chat.js';
import { createStreamRenderer } from './ui/render/stream-renderer.js';
import { postProcessToolCalls, executeAskUser } from './features/feature-tools-ui.js';
import { playCompletionSound } from './ui/ui-widgets.js';

import { buildSystemContent, assembleMessages, estimateTokens, getMainChatSlice, _buildAiContextForHistoryMsg, formatPayloadAsText } from './api/prompt-builder.js';
import { redactRequestBody, logOutgoingRequest, _patchFetchForGeneration, _unpatchFetchForGeneration } from './api/request-inspector.js';

export { buildSystemContent, assembleMessages, estimateTokens, getMainChatSlice, _buildAiContextForHistoryMsg, formatPayloadAsText, _computeSystemPromptSignature } from './api/prompt-builder.js';
export { redactRequestBody, logOutgoingRequest } from './api/request-inspector.js';

// Таймаут одного вызова инструмента: сетевые тулы (search_web/read_url) не должны
// вешать весь раунд. Константа вместо настройки — пока ни один сценарий не потребовал другого.
const TOOL_TIMEOUT_MS = 60000;


function withTimeout(promise, ms = TOOL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Tool did not respond within ${Math.round(ms / 1000)}s`)), ms);
        promise.then(
            v => { clearTimeout(t); resolve(v); },
            e => { clearTimeout(t); reject(e); },
        );
    });
}

// Generation timeouts in a config object: fuzz/soak tests shrink them instead
// of waiting minutes. Defaults: ask_user 5 min, stream stall 5 min (owner
// decision 2026-11-10: 180 s was too little for slow/free providers),
// non-stream hard cap 10 min — a non-stream request is one opaque HTTP call,
// silence inside it is indistinguishable from progress, so its cap is a total
// duration, not a silence window.
export const _genTimeouts = { askUserMs: 300000, stallMs: 300000, nonStreamMs: 600000 };

export async function awaitAskUserAnswer(askPromise) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            resolve(v);
        };
        const timer = setTimeout(() => finish({ __ask_timeout: true }), _genTimeouts.askUserMs);
        const poll = setInterval(() => {
            if (state.generationStopped) finish({ __ask_cancelled: true });
        }, 500);
        askPromise.then(finish);
    });
}

// Resolve the effective streaming mode once, shared by the watchdog (it needs
// to know whether chunks will ever arrive) and the request builder.
// Native function calling: ST's stream parser (getStreamingReply) drops
// delta.tool_calls, so native tool rounds must go non-streaming.
export function resolveUseStream(settings, nativeTools) {
    const ctx = SillyTavern.getContext();
    const streamSetting = settings.forceStreaming;
    let useStream;

    if (streamSetting === 'on' || streamSetting === true) {
        useStream = true;
    } else if (streamSetting === 'off') {
        useStream = false;
    } else {
        useStream = !!(document.getElementById('stream_toggle')?.checked
            ?? ctx.chatCompletionSettings?.stream_openai
            ?? ctx.textCompletionSettings?.streaming
            ?? true);
    }

    if (nativeTools && toOpenAITools().length === 0) nativeTools = false;
    if (nativeTools) useStream = false;
    return { useStream, nativeTools };
}

async function _callGenerateInner(session, settings, pendingText, onChunk, nativeTools = false, genOpts = {}) {
    const ctx = SillyTavern.getContext();
    const messages = await assembleMessages(session, settings, pendingText, null, genOpts);
    const maxTokens = parseInt(settings.maxTokens) || 8200;

    const abort = new AbortController();
    state.abortController = abort;

    const resolved = resolveUseStream(settings, nativeTools);
    const useStream = resolved.useStream;
    nativeTools = resolved.nativeTools;
    const toolsPayload = nativeTools ? { tools: toOpenAITools(), tool_choice: 'auto' } : {};

    function deepExtract(obj) {
        if (!obj || typeof obj !== 'object') return { t: '', r: null };
        let r = null;
        
        if (typeof obj.state?.reasoning === 'string' && obj.state.reasoning !== '') r = obj.state.reasoning;
        else if (typeof obj.reasoning === 'string' && obj.reasoning !== '') r = obj.reasoning;
        else if (typeof obj.reasoning_content === 'string' && obj.reasoning_content !== '') r = obj.reasoning_content;
        else if (typeof obj.thinking === 'string' && obj.thinking !== '') r = obj.thinking;

        else if (typeof obj.original_response?.choices?.[0]?.message?.reasoning === 'string' && obj.original_response.choices[0].message.reasoning !== '') r = obj.original_response.choices[0].message.reasoning;
        else if (typeof obj.original_response?.choices?.[0]?.message?.reasoning_content === 'string' && obj.original_response.choices[0].message.reasoning_content !== '') r = obj.original_response.choices[0].message.reasoning_content;
        else if (typeof obj.choices?.[0]?.message?.reasoning === 'string' && obj.choices[0].message.reasoning !== '') r = obj.choices[0].message.reasoning;
        else if (typeof obj.choices?.[0]?.message?.reasoning_content === 'string' && obj.choices[0].message.reasoning_content !== '') r = obj.choices[0].message.reasoning_content;
        else if (typeof obj.choices?.[0]?.delta?.reasoning === 'string' && obj.choices[0].delta.reasoning !== '') r = obj.choices[0].delta.reasoning;
        else if (typeof obj.choices?.[0]?.delta?.reasoning_content === 'string' && obj.choices[0].delta.reasoning_content !== '') r = obj.choices[0].delta.reasoning_content;

        if (!r) {
            const getGeminiThoughts = (src) => {
                if (Array.isArray(src?.responseContent?.parts)) return src.responseContent.parts;
                if (Array.isArray(src?.candidates?.[0]?.content?.parts)) return src.candidates[0].content.parts;
                return [];
            };
            const geminiParts = [...getGeminiThoughts(obj), ...getGeminiThoughts(obj.original_response)];
            const geminiThoughts = geminiParts.filter(p => p.thought || p.thought === null).map(p => p.text).filter(Boolean);
            if (geminiThoughts.length > 0) r = geminiThoughts.join('\n\n');
        }
        
        if (!r) {
            const getClaudeThoughts = (src) => Array.isArray(src?.content) ? src.content : [];
            const claudeParts = [...getClaudeThoughts(obj), ...getClaudeThoughts(obj.original_response)];
            const claudeThoughts = claudeParts.filter(p => p.type === 'thinking').map(p => p.thinking).filter(Boolean);
            if (claudeThoughts.length > 0) r = claudeThoughts.join('\n\n');
        }
            
        if (!r) {
            const getMistralContent = (src) => Array.isArray(src?.choices?.[0]?.message?.content) ? src.choices[0].message.content : [];
            const mistralParts = [...getMistralContent(obj), ...getMistralContent(obj.original_response)];
            let mistralThoughts = [];
            for (const part of mistralParts) {
                if (Array.isArray(part.thinking)) mistralThoughts.push(...part.thinking.map(t => t.text).filter(Boolean));
                else if (part.type === 'thinking' || part.thinking) mistralThoughts.push(typeof part.thinking === 'string' ? part.thinking : part.text);
            }
            if (mistralThoughts.length > 0) r = mistralThoughts.join('\n\n');
        }

        let t = '';
        if (typeof obj.text === 'string' && obj.text !== '') t = obj.text;
        else if (typeof obj.content === 'string' && obj.content !== '') t = obj.content;
        else if (Array.isArray(obj.content)) {
            const textParts = obj.content.filter(p => p.type === 'text' || (p.text && !p.thought && p.type !== 'thinking')).map(p => p.text).filter(Boolean);
            if (textParts.length > 0) t = textParts.join('\n');
        }
        else if (Array.isArray(obj.responseContent?.parts)) {
            const textParts = obj.responseContent.parts.filter(p => !p.thought && p.thought !== null).map(p => p.text).filter(Boolean);
            if (textParts.length > 0) t = textParts.join('\n');
        }
        else if (typeof obj.message?.content === 'string' && obj.message.content !== '') t = obj.message.content;
        else if (typeof obj.original_response?.choices?.[0]?.message?.content === 'string' && obj.original_response.choices[0].message.content !== '') t = obj.original_response.choices[0].message.content;
        else if (typeof obj.choices?.[0]?.message?.content === 'string' && obj.choices[0].message.content !== '') t = obj.choices[0].message.content;
        else if (typeof obj.choices?.[0]?.delta?.content === 'string' && obj.choices[0].delta.content !== '') t = obj.choices[0].delta.content;
        else if (typeof obj.choices?.[0]?.text === 'string' && obj.choices[0].text !== '') t = obj.choices[0].text;
        else if (typeof obj.results?.[0]?.text === 'string' && obj.results[0].text !== '') t = obj.results[0].text;
        else if (Array.isArray(obj.original_response?.candidates?.[0]?.content?.parts)) {
            const textParts = obj.original_response.candidates[0].content.parts.filter(p => !p.thought && p.thought !== null).map(p => p.text).filter(Boolean);
            if (textParts.length > 0) t = textParts.join('\n');
        }
        else if (Array.isArray(obj.candidates?.[0]?.content?.parts)) {
            const textParts = obj.candidates[0].content.parts.filter(p => !p.thought && p.thought !== null).map(p => p.text).filter(Boolean);
            if (textParts.length > 0) t = textParts.join('\n');
        }

        // Прокси (Elysium и подобные) в tool_call-раунде возвращают content,
        // сериализованный как JSON-строку пустоты: '""'. Это не текст ответа.
        if (t === '""' || t === "''") t = '';

        return { t, r };
    }

    if (settings.connectionSource === 'custom') {
        let text = '';
        let reasoning = null;
        let reasoningStartMs = null;
        let reasoningDone = false;

        try {
            const url = (settings.customUrl || 'http://localhost:5000/v1').replace(/\/+$/, '') + '/chat/completions';
            const payload = {
                model: settings.customModel || 'gpt-3.5-turbo',
                messages: messages,
                max_tokens: maxTokens,
                stream: useStream,
                ...toolsPayload,
            };
            const headers = { 'Content-Type': 'application/json' };
            if (settings.customKey) headers['Authorization'] = `Bearer ${settings.customKey}`;

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: abort.signal
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => res.statusText);
                throw new Error(`Custom API Error ${res.status}: ${errText}`);
            }

            if (useStream) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";

                while (true) {
                    if (abort.signal.aborted) { if (state.abortController === abort) state.abortController = null; return null; }
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); 

                    for (const line of lines) {
                        const l = line.trim();
                        if (!l || l.startsWith(':') || l === 'data: [DONE]') continue;
                        if (l.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(l.slice(6));
                                const ext = deepExtract(data);
                                if (ext.t) text += ext.t;
                                if (ext.r) {
                                    if (reasoningStartMs === null) reasoningStartMs = performance.now();
                                    reasoning = (reasoning || '') + ext.r;
                                }
                                if (text && !reasoningDone && reasoning) {
                                    reasoningDone = true;
                                    data._finalReasoningMs = performance.now() - reasoningStartMs;
                                }
                                if (typeof onChunk === 'function') {
                                    const rMs = reasoningDone && data._finalReasoningMs ? data._finalReasoningMs : (reasoningStartMs !== null ? performance.now() - reasoningStartMs : null);
                                    onChunk(text, reasoning, rMs, reasoningDone);
                                }
                            } catch (e) {}
                        }
                    }
                }
            } else {
                const data = await res.json();
                const ext = deepExtract(data);
                text = ext.t || '';
                reasoning = ext.r;
                const prov = extractProviderToolCalls(data);
            if (state.abortController === abort) state.abortController = null;
                return { text: text.trim(), reasoning, isMaxTokens: false, toolCalls: prov?.calls || null, rawToolCalls: prov?.raw || null };
            }
        } catch (e) {
            if (state.abortController === abort) state.abortController = null;
            // Чужой AbortError (сеть/браузер оборвали fetch без нашего сигнала)
            // не глотаем — пробрасываем в обработчик ошибок, иначе запрос умирал
            // молча (BUG-6: ни ответа, ни диалога, частичный текст терялся из вида).
            if (abort.signal.aborted) return null;
            throw e;
        }

        if (state.abortController === abort) state.abortController = null;
        return { text: text.trim(), reasoning, isMaxTokens: false, toolCalls: null, rawToolCalls: null };
    }

    const service = ctx.ConnectionManagerRequestService;
    let profiles = [];
    if (service && typeof service.getSupportedProfiles === 'function') {
        profiles = service.getSupportedProfiles();
    } else {
        profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
    }

    let useConnectionManager = false;
    let profileId = null;

    if (settings.connectionSource === 'profile') {
        if (settings.connectionProfileId) {
            const found = profiles.find(p =>
                p.id === settings.connectionProfileId || p.name === settings.connectionProfileId
            );
            if (found) {
                profileId = found.id;
                useConnectionManager = true;
            } else {
                throw new Error(`Connection profile "${settings.connectionProfileId}" not found. Available: ${profiles.map(p => p.name).join(', ') || 'None'}`);
            }
        } else {
            throw new Error('No profile selected in ST-Copilot settings.');
        }
    } else if (settings.connectionSource !== 'custom') {
        const domSelect = document.getElementById('connection_profiles');
        if (domSelect && domSelect.value) {
            profileId = domSelect.value;
        } else if (ctx.extensionSettings?.connectionManager?.selectedProfile) {
            profileId = ctx.extensionSettings.connectionManager.selectedProfile;
        }
        
        if (profileId) {
            useConnectionManager = true;
        }
    }

    let asyncGeneratorFn;

    // Перехват window.fetch на время ИНИЦИАЦИИ запроса (sendRequest/processRequest
    // делают fetch внутри себя): нормализуем тело (reasoning_effort и пр.) и пишем
    // в журнал инспектора. Scope сужен до бэкенд-эндпоинтов генерации ST, чтобы не
    // трогать чужие запросы; счётчик вложенности делает restore корректным при
    // пересекающихся генерациях (раньше внешний finally гасил патч внутренней).
    _patchFetchForGeneration();

    try {
        if (useConnectionManager && service && typeof service.sendRequest === 'function') {
            asyncGeneratorFn = await service.sendRequest(profileId, messages, maxTokens, {
                stream: useStream,
                signal: abort.signal,
                extractData: false,
                includePreset: true
            }, toolsPayload);
        } else {
            const mainApi = ctx.mainApi || document.getElementById('main_api')?.value;
            if (mainApi === 'openai' && ctx.ChatCompletionService) {
                const oaiSettings = window.oai_settings || ctx.oai_settings || {};
                asyncGeneratorFn = await ctx.ChatCompletionService.processRequest({
                    messages: messages,
                    max_tokens: maxTokens,
                    stream: useStream,
                    ...toolsPayload
                }, { presetName: oaiSettings.preset_settings_openai }, false, abort.signal);
            } else if (mainApi === 'textgenerationwebui' && ctx.TextCompletionService) {
                const textGenSettings = window.textgenerationwebui_settings || ctx.textgenerationwebui_settings || {};
                asyncGeneratorFn = await ctx.TextCompletionService.processRequest({
                    prompt: messages,
                    max_tokens: maxTokens,
                    stream: useStream,
                    ...toolsPayload
                }, { presetName: textGenSettings.preset_settings_textgenerationwebui }, false, abort.signal);
            } else {
                throw new Error('No active API connection found. Please select a profile in Connection Manager or configure the main API.');
            }
        }
    } catch (e) {
        if (useStream && !abort.signal.aborted && e?.name !== 'AbortError' && e?.message !== 'userStopped') {
            console.warn(`[${EXT_DISPLAY}] Streaming failed, falling back to non-streaming:`, e);
            _dbgAdd('GEN_STREAM_FALLBACK', { error: e.message || String(e) });
            useStream = false;
            try {
                if (useConnectionManager && service && typeof service.sendRequest === 'function') {
                    asyncGeneratorFn = await service.sendRequest(profileId, messages, maxTokens, {
                        stream: false,
                        signal: abort.signal,
                        extractData: false,
                        includePreset: true
                    }, toolsPayload);
                } else {
                    const mainApi = ctx.mainApi || document.getElementById('main_api')?.value;
                    if (mainApi === 'openai' && ctx.ChatCompletionService) {
                        const oaiSettings = window.oai_settings || ctx.oai_settings || {};
                        asyncGeneratorFn = await ctx.ChatCompletionService.processRequest({
                            messages: messages,
                            max_tokens: maxTokens,
                            stream: false,
                            ...toolsPayload
                        }, { presetName: oaiSettings.preset_settings_openai }, false, abort.signal);
                    } else if (mainApi === 'textgenerationwebui' && ctx.TextCompletionService) {
                        const textGenSettings = window.textgenerationwebui_settings || ctx.textgenerationwebui_settings || {};
                        asyncGeneratorFn = await ctx.TextCompletionService.processRequest({
                            prompt: messages,
                            max_tokens: maxTokens,
                            stream: false,
                            ...toolsPayload
                        }, { presetName: textGenSettings.preset_settings_textgenerationwebui }, false, abort.signal);
                    }
                }
            } catch (err2) {
            if (state.abortController === abort) state.abortController = null;
                if (abort.signal.aborted || err2?.message === 'userStopped') return null;
                if (err2.cause) err2.message = `${err2.message} — CAUSE: ${err2.cause.message || String(err2.cause)}`;
                throw err2;
            }
        } else {
            if (state.abortController === abort) state.abortController = null;
            if (abort.signal.aborted || e?.message === 'userStopped') return null;
            if (e.cause) e.message = `${e.message} — CAUSE: ${e.cause.message || String(e.cause)}`;
            throw e;
        }
    } finally {
        _unpatchFetchForGeneration();
    }

    let text = '';
    let reasoning = null;
    let reasoningStartMs = null;
    let reasoningDone = false;

    const isGen = typeof asyncGeneratorFn === 'function' ||
        (asyncGeneratorFn != null && typeof asyncGeneratorFn[Symbol.asyncIterator] === 'function') ||
        (asyncGeneratorFn != null && typeof asyncGeneratorFn.next === 'function');

    let lastValue = null;

    if (!isGen) {
        const value = asyncGeneratorFn;
        let toolCalls = null;
        let rawToolCalls = null;
        if (typeof value === 'string') {
            text = value.trim();
        } else {
            const ext = deepExtract(value);
            text = ext.t.trim();
            reasoning = ext.r;
            lastValue = value;
            const prov = extractProviderToolCalls(value);
            toolCalls = prov?.calls || null;
            rawToolCalls = prov?.raw || null;
        }

        const finishReason = lastValue?.finish_reason || lastValue?.state?.finish_reason || lastValue?.stop_reason || lastValue?.choices?.[0]?.finish_reason;
        const isMaxTokens = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'stop_limit';

        // Текстовый протокол: хвост после закрытого tool_call — выдуманный
        // моделью «результат»; отсекаем его и тут.
        if (settings.toolsEnabled && !nativeTools) {
            const cut = findToolCallCut(text);
            if (cut !== -1) {
                _dbgAdd('GEN_TOOL_CALL_CUT', { cutAt: cut, droppedTail: text.length - cut });
                text = text.slice(0, cut).trim();
            }
        }

        if (state.abortController === abort) state.abortController = null;
        return { text, reasoning, isMaxTokens, toolCalls, rawToolCalls };
    }

    const gen = typeof asyncGeneratorFn === 'function' ? asyncGeneratorFn() : asyncGeneratorFn;

    // Стриминг + текстовый протокол: как только закрылся tool_call-блок и модель
    // начала писать дальше — обрываем генерацию (abort), иначе она додумает
    // «результат» инструмента. Ответ возвращается усечённым по точке обрыва.
    const tcCutEnabled = !!settings.toolsEnabled && !nativeTools;
    let tcCutAt = null;
    const cutResult = () => tcCutAt === null ? undefined
        : { text: text.slice(0, tcCutAt).trim(), reasoning, isMaxTokens: false, toolCalls: null, rawToolCalls: null };

    try {
        while (true) {
            if (abort.signal.aborted) { if (state.abortController === abort) state.abortController = null; const c = cutResult(); if (c) return c; return null; }
            const { value, done } = await gen.next();
            if (done) {
                if (value) lastValue = value;
                break;
            }
            lastValue = value;

            const ext = deepExtract(value);
            text = ext.t;
            const newReasoning = ext.r;

            if (newReasoning) {
                if (reasoningStartMs === null) reasoningStartMs = performance.now();
                reasoning = newReasoning;
            }
            if (text && !reasoningDone && reasoning) {
                reasoningDone = true;
                lastValue._finalReasoningMs = performance.now() - reasoningStartMs;
            }

            if (typeof onChunk === 'function') {
                const reasoningMs = reasoningDone && lastValue?._finalReasoningMs 
                    ? lastValue._finalReasoningMs 
                    : (reasoningStartMs !== null ? performance.now() - reasoningStartMs : null);
                onChunk(text, reasoning, reasoningMs, reasoningDone);
            }

            if (tcCutEnabled && tcCutAt === null) {
                const cutIdx = findToolCallCut(text);
                if (cutIdx !== -1) {
                    tcCutAt = cutIdx;
                    _dbgAdd('GEN_TOOL_CALL_CUT', { cutAt: cutIdx, droppedTail: text.length - cutIdx });
                    abort.abort();
                }
            }
        }
    } catch (e) {
        if (state.abortController === abort) state.abortController = null;
        if (tcCutAt !== null) { const c = cutResult(); if (c) return c; }
        if (abort.signal.aborted || e?.message === 'userStopped') return null;
        throw e;
    }

    const finishReason = lastValue?.finish_reason || lastValue?.state?.finish_reason || lastValue?.stop_reason || lastValue?.choices?.[0]?.finish_reason;
    const isMaxTokens = finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'stop_limit';

    if (state.abortController === abort) state.abortController = null;
    return { text: text.trim(), reasoning, isMaxTokens, toolCalls: null, rawToolCalls: null };
}

// Watchdog: an open SSE connection without chunks used to hold generation
// forever (only manual Stop cleared it). Streaming requests re-arm the timer
// on every chunk; non-streaming requests never chunk, so they get a single
// longer total-duration cap instead (see _genTimeouts.nonStreamMs). Fire =
// abort + marked error so the UI shows it instead of hanging silently.

export async function callGenerate(session, settings, pendingText, onChunk, nativeTools = false, genOpts = {}) {
    let stalled = false;
    let stallTimer = null;
    // ponytail: resolveUseStream reads the DOM/toggle again — cheap, and the
    // alternative is threading a flag through every callGenerate caller.
    const willStream = resolveUseStream(settings, nativeTools).useStream;
    const capMs = willStream ? _genTimeouts.stallMs : _genTimeouts.nonStreamMs;
    const pet = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            stalled = true;
            _dbgAdd('GEN_STALL_TIMEOUT', { timeoutMs: capMs, streaming: willStream });
            try { state.abortController?.abort(); } catch (_) {}
        }, capMs);
    };
    pet();
    try {
        const result = await _callGenerateInner(session, settings, pendingText,
            typeof onChunk === 'function' ? (...a) => { pet(); onChunk(...a); } : onChunk,
            nativeTools, genOpts);
        if (result === null && stalled && !state.generationStopped) {
            const err = new Error(`Генерация зависла: провайдер не присылал данные ${Math.round(_genTimeouts.stallMs / 1000)} с подряд. Запрос прерван — проверьте соединение и повторите.`);
            err._stalled = true;
            throw err;
        }
        return result;
    } finally {
        clearTimeout(stallTimer);
    }
}

export async function runGenerate(session, userText, addUserMsg = true, processedAtts = null) {
    if (state.generating) return;
    state.generating = true;
    state.generationStopped = false;
    const myEpoch = ++state.genEpoch;
    state.activeToolCalls = [];
    const settings = getEffectiveSettings();
    setGeneratingState(true);

    let streamMsgId = null;
    let streamMsgEl = null;
    let streamContentEl = null;
    let streamReasoningBlockEl = null;
    let streamReasoningSummaryEl = null;
    let streamReasoningContentEl = null;
    let cursorEl = null;
    let isStreaming = false;
    let streamAccumText = '';
    let streamAccumReasoning = null;
    // Hoisted for the catch: a throw in tool round >=2 must not cost the
    // completed rounds' text — the catch salvages these into the message.
    let accumulatedText = '';
    let accumulatedReasoning = null;
    let lastRoundPartialText = '';
    let genToolRound = 0;
    // RAF-throttle стриминга: раньше на каждый чанк (~50-100ms) шёл полный
    // innerHTML = renderMarkdown(stripMemoryBlock(text)) → O(N²) по ростущей длине.
    // Теперь обновляем DOM не чаще 60fps — падение CPU без изменения визуального
    // результата. _rafScheduled гасит дребезг дубль-чанков внутри одного кадра.
    let _streamRafScheduled = false;
    let _streamPendingArgs = null;
    let streamRenderer = null;
    let reasoningRenderer = null;

    const cleanupCursor = () => {
        // Сброс pending RAF: мы покидаем контекст стрима, и incidental flush после
        // удаления эл-та курса мог бы бросать исключение или перерисовать устаревший DOM.
        _streamRafScheduled = false;
        _streamPendingArgs = null;
        if (streamRenderer) { streamRenderer.destroy(); streamRenderer = null; }
        if (reasoningRenderer) { reasoningRenderer.destroy(); reasoningRenderer = null; }
        if (cursorEl && cursorEl.parentNode) cursorEl.remove();
        cursorEl = null;
    };

    const onChunk = (text, reasoning, reasoningMs, reasoningDone) => {
        isStreaming = true;
        streamAccumText = text;
        streamAccumReasoning = reasoning;

        if (!streamMsgId) {
            const placeholder = { id: `msg_${Date.now()}`, role: 'assistant', content: '', reasoning: null, timestamp: Date.now() };
            session.messages.push(placeholder);
            streamMsgId = placeholder.id;

            appendMsgEl(placeholder, true);

            streamMsgEl = document.querySelector(`.scp-msg[data-id="${streamMsgId}"]`);
            if (streamMsgEl) {
                const body = streamMsgEl.querySelector('.scp-msg-body');
                streamContentEl = streamMsgEl.querySelector('.scp-msg-content');

                streamReasoningBlockEl = document.createElement('details');
                streamReasoningBlockEl.className = 'scp-reasoning-block';
                streamReasoningBlockEl.style.display = 'none';
                streamReasoningSummaryEl = document.createElement('summary');
                streamReasoningSummaryEl.className = 'scp-reasoning-summary';
                streamReasoningSummaryEl.textContent = 'Думаю…';
                streamReasoningContentEl = document.createElement('div');
                streamReasoningContentEl.className = 'scp-reasoning-content';
                streamReasoningBlockEl.appendChild(streamReasoningSummaryEl);
                streamReasoningBlockEl.appendChild(streamReasoningContentEl);
                if (body) body.insertBefore(streamReasoningBlockEl, streamContentEl);

                cursorEl = document.createElement('span');
                cursorEl.className = 'scp-stream-cursor';

                streamRenderer = createStreamRenderer({
                    el: streamContentEl,
                    preprocessed: true,
                    onScroll: () => smartScrollToBottom(),
                });
                streamRenderer.setCursor(cursorEl);
                reasoningRenderer = createStreamRenderer({
                    el: streamReasoningContentEl,
                    preprocessed: true,
                });

                const bar = document.getElementById('scp-thinking-bar');
                if (bar) bar.style.display = 'flex';
            }
        }

        // RAF throttle: копим последний аргумент-набор, пере-рендер не чаще 60fps.
        // Visual идентичен: при каждом flush'е рендерим текущий streamAccumText целиком
        // (как и раньше — никакого дельта-merge), просто режем частоту.
        _streamPendingArgs = { text, reasoning, reasoningMs, reasoningDone };
        if (!_streamRafScheduled && streamContentEl) {
            _streamRafScheduled = true;
            const schedule = (typeof requestAnimationFrame === 'function')
                ? requestAnimationFrame
                : (cb) => setTimeout(cb, 16);
            schedule(() => {
                _streamRafScheduled = false;
                const args = _streamPendingArgs;
                if (!args) return;
                _streamFlushChunk(args);
                _streamPendingArgs = null;
            });
        }
    };

    // Тот же код рендера, что и раньше, но вызывается из RAF callback'а.
    const _streamFlushChunk = ({ text, reasoning, reasoningMs, reasoningDone }) => {
        if (!streamContentEl) return;
        let procReasoning = reasoning || '';
        // Дешёвые guard'ы: полнотекстовые replace гоняются только когда маркеры есть.
        let procText = /```memory-update/i.test(text) ? stripMemoryBlock(text) : text;

        let tcIndex = 0;
        // Контент первым: исполненные инструменты соответствуют фенсам контента.
        if (/```tool_call/i.test(procText)) {
            const resC = extractToolCallPlaceholders(procText, tcIndex);
            procText = resC.text;
            tcIndex = resC.nextIndex;
        }
        if (procReasoning && /```tool_call/i.test(procReasoning)) {
            const resR = extractToolCallPlaceholders(procReasoning, tcIndex);
            procReasoning = resR.text;
            tcIndex = resR.nextIndex;
        }

        if (reasoning && streamReasoningBlockEl) {
            streamReasoningBlockEl.style.display = '';
            if (reasoningRenderer) reasoningRenderer.push(procReasoning);
            const secs = reasoningMs ? (reasoningMs / 1000).toFixed(1) : null;
            streamReasoningSummaryEl.textContent = reasoningDone
                ? `Думал ${secs} с`
                : secs ? `Думаю ${secs} с…` : 'Думаю…';
        }

        // Инкрементальный рендер: рендерер фиксирует дельту по безопасным
        // границам markdown и троттлит через RAF — полный re-render на кадр не нужен.
        streamRenderer.push(procText);

        if (state.activeToolCalls.length || tcIndex > 0) {
            const liveTCs = parseToolCallsFromText(text + '\n' + (reasoning || ''));
            const displayed = liveTCs.map((tc, i) => state.activeToolCalls[i] || {
                id: `live_${i}`, name: tc.name, input: tc.input, status: 'running', result: undefined
            });
            postProcessToolCalls(streamMsgEl, displayed);
        }
        smartScrollToBottom();
    };

    try {
        if (addUserMsg && (userText || (processedAtts && processedAtts.length))) {
            const msgObj = addMessage(session, 'user', userText, { 
                attachments: processedAtts || []
            });
            appendMsgEl(msgObj);
            recordStat(SM.msg);
        }

        const fullMessages = await assembleMessages(session, settings, null);
        const fullPromptText = fullMessages.map(m => typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '')).join('\n');
        const tokensIn = await estimateTokens(fullPromptText);

        _dbgAdd('GEN_START', {
            src: settings.connectionSource,
            profile: settings.connectionProfileId || null,
            maxTokens: settings.maxTokens,
            streaming: settings.forceStreaming,
            ctxDepth: settings.contextDepth,
            tokensIn
        });

        const nativeTools = settings.toolsEnabled && settings.toolsProtocol === 'native';
        let result = await callGenerate(session, settings, null, onChunk, nativeTools);

        cleanupCursor();

        if (result && !result.text.trim() && !result.reasoning?.trim()) {
            toastr.warning('⚠ Генерация не удалась: ИИ вернул пустой ответ.', EXT_DISPLAY, { timeOut: 10000 });
        }

        if (result !== null && settings.toolsEnabled && getEnabledTools().length > 0) {
            const maxRounds = settings.toolsMaxRounds ?? 5;
            let roundText = result.text || '';
            let roundReasoning = result.reasoning;
            let roundToolCalls = result.toolCalls || null;
            let roundRawToolCalls = result.rawToolCalls || null;
            let extraHistory = [];
            let nativeHistory = [];
            // Анти-цикл: фингерпринты успешно исполненных вызовов за генерацию.
            // Повтор с теми же аргументами не исполняется — модель получает заметку
            // и должна уточнить запрос или ответить. Ошибки в Set не попадают: ретрай легален.
            const executedToolFingerprints = new Set();
            // Раунды тулов (перезаписывается каждый раунд): финальный no-tools
            // проход использует последний, чтобы подложить результаты в промпт.
            let roundEntries = [];

            accumulatedText = roundText;
            accumulatedReasoning = roundReasoning || null;
            // Текст текущего раунда по состоянию на последний чанк: при Stop
            // посреди раунда nextResult=null, и без него настримленный кусок
            // пропадал из финального сообщения, хотя был виден на экране.
            lastRoundPartialText = '';
            // Ретрай пустого continuation — один на всю генерацию, чтобы не зациклиться.
            let emptyContinuationRetried = false;

            const _updateLiveUI = (tempText = '', tempReasoning = null) => {
                if (!streamMsgEl || !streamContentEl) return;
                let combinedText = tempText ? accumulatedText + '\n\n' + tempText : accumulatedText;
                let combinedReasoning = accumulatedReasoning || '';
                if (tempReasoning) {
                    combinedReasoning = combinedReasoning ? combinedReasoning + '\n\n' + tempReasoning : tempReasoning;
                }
                
                let procReasoning = combinedReasoning;
                let procText = /```memory-update/i.test(combinedText) ? stripMemoryBlock(combinedText) : combinedText;
                let tcIndex = 0;

                // Контент первым: см. комментарий в _streamFlushChunk.
                if (/```tool_call/i.test(procText)) {
                    const resC = extractToolCallPlaceholders(procText, tcIndex);
                    procText = resC.text;
                    tcIndex = resC.nextIndex;
                }
                if (procReasoning && /```tool_call/i.test(procReasoning)) {
                    const resR = extractToolCallPlaceholders(procReasoning, tcIndex);
                    procReasoning = resR.text;
                    tcIndex = resR.nextIndex;
                }

                // cleanupCursor() после раунда 1 уничтожил рендереры —
                // пересоздаём, иначе раунды 2+ идут вслепую (текст не стримится).
                // recreated-рендерер с renderedLen=0 при первом push делает полный
                // innerHTML-replace — накопленный текст раунда 1 перерисуется корректно.
                if (!streamRenderer && streamContentEl) {
                    streamRenderer = createStreamRenderer({ el: streamContentEl, preprocessed: true, onScroll: () => smartScrollToBottom() });
                }
                if (!reasoningRenderer && streamReasoningContentEl) {
                    reasoningRenderer = createStreamRenderer({ el: streamReasoningContentEl, preprocessed: true });
                }

                if (combinedReasoning && streamReasoningBlockEl) {
                    streamReasoningBlockEl.style.display = '';
                    if (reasoningRenderer) reasoningRenderer.push(procReasoning);
                }
                if (streamRenderer) streamRenderer.push(procText);

                if (state.activeToolCalls.length || tcIndex > 0) {
                    postProcessToolCalls(streamMsgEl, state.activeToolCalls);
                }
                smartScrollToBottom();
            };

            for (let round = 0; round < maxRounds; round++) {
                genToolRound = round + 1;
                const tcs = nativeTools ? (roundToolCalls || []) : parseToolCallsFromText(roundText);
                if (!tcs.length) break;

                roundEntries = [];
                for (const tc of tcs) {
                    const tcId = `tc_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
                    const entry = { id: tcId, callId: tc.callId || null, name: tc.name, input: tc.input || {}, status: 'running', result: undefined };
                    state.activeToolCalls.push(entry);
                    roundEntries.push(entry);
                }
                _updateLiveUI();

                const execEntry = async (entry) => {
                    if (state.generationStopped || state.abortController?.signal.aborted || myEpoch !== state.genEpoch) {
                        entry.result = { error: 'Generation stopped by user.' };
                        entry.status = 'error';
                        return;
                    }
                    try {
                        const fingerprint = `${entry.name}:${JSON.stringify(entry.input)}`;
                        if (executedToolFingerprints.has(fingerprint)) {
                            _dbgAdd('TOOL_CALL_DUPLICATE_SKIPPED', { toolName: entry.name });
                            entry.result = { note: 'This exact call was already executed this generation — the result is above in context. Refine the arguments or answer the user now.' };
                            entry.status = 'done';
                            return;
                        }
                        const t0 = performance.now();
                        const res = await withTimeout(executeTool(entry.name, entry.input));
                        if (res?.__ask_user) {
                            if (!streamMsgEl) {
                                entry.result = { warning: 'ask_user requires streaming to be enabled.' };
                                entry.status = 'warning';
                            } else {
                                const answer = await awaitAskUserAnswer(executeAskUser(res, streamMsgEl));
                                if (answer?.__ask_timeout) {
                                    entry.result = { error: 'Пользователь не ответил за 5 минут.' };
                                    entry.status = 'warning';
                                } else if (answer?.__ask_cancelled) {
                                    entry.result = { error: `Ожидание ответа прервано (${answer.reason}).` };
                                    entry.status = 'error';
                                } else {
                                    entry.result = answer;
                                    entry.status = 'done';
                                }
                            }
                        } else {
                            entry.result = res;
                            entry.status = 'done';
                        }
                        // Successful executions were invisible in the debug log —
                        // the interruption diagnosis needs the full per-tool trail.
                        _dbgAdd('TOOL_EXECUTED', { toolName: entry.name, status: entry.status, ms: Math.round(performance.now() - t0) });
                        if (entry.status === 'done') executedToolFingerprints.add(fingerprint);
                    } catch (e) {
                        _dbgAdd('TOOL_EXECUTION_FAILED', { toolName: entry.name, error: e.message });
                        entry.result = { error: e.message };
                        entry.status = 'error';
                    }
                };

                // Параллельно всё, кроме ask_user — его резолвер DOM-синглтон и он
                // останавливает цикл до ответа человека, параллелить его нельзя.
                await Promise.all(roundEntries.filter(e => e.name !== 'ask_user').map(execEntry));
                for (const entry of roundEntries.filter(e => e.name === 'ask_user')) {
                    await execEntry(entry);
                }
                _updateLiveUI();

                // Stop, нажатый во время исполнения инструментов: не запускаем
                // следующий раунд — выходим с тем, что успели накопить.
                if (state.generationStopped || myEpoch !== state.genEpoch) break;

                if (nativeTools) {
                    const rawCalls = roundRawToolCalls || roundEntries.map((e, i) => ({
                        id: e.callId || `call_${round}_${i}`,
                        type: 'function',
                        function: { name: e.name, arguments: JSON.stringify(e.input) },
                    }));
                    nativeHistory.push({ role: 'assistant', content: roundText || '', tool_calls: rawCalls, _round: round });
                    for (const e of roundEntries) {
                        nativeHistory.push({
                            role: 'tool',
                            tool_call_id: e.callId || `call_${round}_${roundEntries.indexOf(e)}`,
                            content: JSON.stringify(e.result ?? null),
                            _toolName: e.name,
                            _round: round,
                        });
                    }
                    // Компакция (паттерн Anthropic clear_tool_uses): результаты всех раундов,
                    // кроме последнего исполненного, сжимаются в плейсхолдер. Свежий раунд
                    // обязан остаться verbatim — иначе модель не увидит результаты, ради
                    // которых вызывала инструменты. assistant.tool_calls не трогаем: API
                    // требует пары tool_calls → tool-сообщение.
                    for (const m of nativeHistory) {
                        if (m.role === 'tool' && m._round < round - 1) {
                            m.content = `[${m._toolName}: result removed from context to save tokens]`;
                        }
                    }
                    for (const eh of nativeHistory) {
                        session.messages.push({ id: `tc_hist_${round}_${nativeHistory.indexOf(eh)}`, role: eh.role, content: eh.content, tool_calls: eh.tool_calls, tool_call_id: eh.tool_call_id, timestamp: Date.now(), _tcTemp: true });
                    }
                } else {
                    extraHistory.push({ role: 'assistant', content: stripMemoryBlock(roundText) });
                    const toolResultsText = roundEntries.map(e =>
                        `<tool_result name="${e.name}" status="${e.status}">\n${typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2)}\n</tool_result>`
                    ).join("\n");

                    extraHistory.push({ role: 'user', content: `<tool_results>\n${toolResultsText}\n</tool_results>\n\nCONTINUE your response using these results. Write exactly where you left off.`, _round: round });

                    // Компакция как в native-ветке: свежие результаты обязательны,
                    // более старые раунды сжимаются в плейсхолдер.
                    for (const eh of extraHistory) {
                        if (eh._round !== undefined && eh._round < round - 1) {
                            eh.content = `[tool results from round ${eh._round + 1} removed from context to save tokens]`;
                        }
                    }

                    for (const eh of extraHistory) {
                        session.messages.push({ id: `tc_hist_${Date.now()}_${extraHistory.indexOf(eh)}_${round}`, role: eh.role, content: eh.content, timestamp: Date.now(), _tcTemp: true });
                    }
                }

                const thinkingText = document.getElementById('scp-thinking-text');
                if (thinkingText) thinkingText.textContent = `Раунд ${round + 2}/${maxRounds + 1}…`;
                const bar = document.getElementById('scp-thinking-bar');
                if (bar) bar.style.display = 'flex';

                isStreaming = false;
                streamAccumText = '';
                const cursor2 = document.createElement('span');
                cursor2.className = 'scp-stream-cursor';

                const tempSession = {
                    ...session,
                    messages: session.messages.filter(m => m.id !== streamMsgId)
                };

                lastRoundPartialText = '';
                let nextResult = await callGenerate(tempSession, settings, null, (t, r) => {
                    if (t) lastRoundPartialText = t;
                    _updateLiveUI(t, r);
                    if (streamContentEl) streamContentEl.appendChild(cursor2);
                }, nativeTools);

                // Пустой continuation (ни текста, ни новых вызовов) — типичный обрыв
                // после тривиального результата тула (например, пустой лорбук): модель
                // молча останавливается, и финальным текстом остаётся голый tool_call-блок.
                // Даём модели один шанс продолжить с явной подсказкой.
                if (nextResult !== null
                    && !String(nextResult.text || '').trim()
                    && !(nextResult.toolCalls || []).length
                    && !emptyContinuationRetried) {
                    emptyContinuationRetried = true;
                    _dbgAdd('GEN_ROUND_EMPTY_RETRY', { round: round + 2 });
                    const retry = await callGenerate(tempSession, settings,
                        '(system note: your previous reply was empty. You MUST now write the actual answer to the user, using the tool results above. Do not call the same tool again.)',
                        (t, r) => {
                            _updateLiveUI(t, r);
                            if (streamContentEl) streamContentEl.appendChild(cursor2);
                        }, nativeTools);
                    if (retry !== null) {
                        nextResult.text = retry.text;
                        nextResult.reasoning = nextResult.reasoning || retry.reasoning;
                        nextResult.toolCalls = retry.toolCalls;
                        nextResult.rawToolCalls = retry.rawToolCalls;
                    }
                }

                session.messages = session.messages.filter(m => !m._tcTemp);
                cursor2.remove();

                _dbgAdd('GEN_TOOL_ROUND', {
                    round: round + 2,
                    textLen: (nextResult?.text || '').length,
                    toolCalls: (nextResult?.toolCalls || parseToolCallsFromText(nextResult?.text || '')).map(t => t.name),
                    empty: nextResult !== null && !String(nextResult?.text || '').trim(),
                });

                if (nextResult === null) {
                    // Stop посреди раунда: сохраняем настримленный кусок раунда,
                    // иначе он был бы виден на экране, но потерян в сохранённом тексте.
                    if (lastRoundPartialText.trim()) accumulatedText += '\n\n' + lastRoundPartialText;
                    result = { text: accumulatedText, reasoning: accumulatedReasoning };
                    break;
                }

                roundText = nextResult.text || '';
                roundReasoning = nextResult.reasoning || null;
                roundToolCalls = nextResult.toolCalls || null;
                roundRawToolCalls = nextResult.rawToolCalls || null;

                accumulatedText += '\n\n' + roundText;
                if (roundReasoning) {
                    accumulatedReasoning = accumulatedReasoning ? accumulatedReasoning + '\n\n' + roundReasoning : roundReasoning;
                }

                result = { text: accumulatedText, reasoning: accumulatedReasoning };
            }

            // Раунды исчерпаны (или модель упорно молчит), а текста так и нет:
            // один финальный проход БЕЗ инструментов. Результаты тулов
            // подкладываем вручную — _tcTemp-сообщения из истории уже вычищены,
            // и без них модель не смогла бы ответить по существу.
            if (result !== null && state.activeToolCalls.length
                && !stripToolCallsFromText(result.text || '').trim()
                && !state.generationStopped && myEpoch === state.genEpoch) {
                _dbgAdd('GEN_FINAL_ANSWER_RETRY', {});
                const resultsText = roundEntries.map(e =>
                    `<tool_result name="${e.name}" status="${e.status}">\n${typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2)}\n</tool_result>`
                ).join('\n');
                const finalSession = { ...session, messages: session.messages.filter(m => m.id !== streamMsgId) };
                const retry = await callGenerate(finalSession, settings,
                    `<tool_results>\n${resultsText}\n</tool_results>\n\n(system note: your tool budget is exhausted. Using the tool results above, write your final answer to the user now. Do not attempt to call any more tools.)`,
                    (t, r) => _updateLiveUI(t, r), false, { noTools: true });
                const retryText = retry ? stripToolCallsFromText(retry.text || '').trim() : '';
                if (retryText) {
                    accumulatedText += '\n\n' + retryText;
                    if (retry.reasoning) {
                        accumulatedReasoning = accumulatedReasoning ? accumulatedReasoning + '\n\n' + retry.reasoning : retry.reasoning;
                    }
                    result = { text: accumulatedText, reasoning: accumulatedReasoning };
                }
            }
        }

        // Страховка от «тихого» завершения: инструменты отработали, а текста модель
        // так и не написала — сообщение не должно рендериться пустым.
        if (result !== null && state.activeToolCalls.length && !stripToolCallsFromText(result.text || '').trim()) {
            _dbgAdd('GEN_EMPTY_FINAL_TEXT', { toolCalls: state.activeToolCalls.map(t => t.name) });
            result.text = (result.text || '') + '\n\n_Модель завершила ответ, не написав текст после вызова инструментов. Попробуйте переспросить или повторить запрос._';
        }

        if (result === null) {
            if (streamMsgId && isStreaming && streamAccumText) {
                const msg = session.messages.find(m => m.id === streamMsgId);
                if (msg) { msg.content = streamAccumText; msg.reasoning = streamAccumReasoning || null; saveSessionsToMetadata(); }
                if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(streamAccumText); postProcessHTMLBlocks(streamContentEl); }
            } else if (streamMsgId) {
                const idx = session.messages.findIndex(m => m.id === streamMsgId);
                if (idx >= 0 && !session.messages[idx].content) {
                    session.messages.splice(idx, 1);
                    streamMsgEl?.remove();
                    updateMsgCount(session);
                }
            }
            return;
        }

        const { text: rawFullText, reasoning: fullReasoning } = result;
        const rawNormalized = normalizeCharNamesInBlock(rawFullText); 
        processMemoryUpdates(rawNormalized, streamMsgId);
        const fullText = stripMemoryBlock(rawNormalized);

        if (streamMsgId) {
            const msg = session.messages.find(m => m.id === streamMsgId);
            if (msg) {
                msg.content = fullText;
                msg.reasoning = fullReasoning || null;
                msg.toolCalls = state.activeToolCalls.length ? JSON.parse(JSON.stringify(state.activeToolCalls)) : undefined;
                msg.genStamp = getGenStamp(settings) || undefined;
                const metaEl = streamMsgEl?.querySelector('.scp-msg-meta');
                if (metaEl && msg.genStamp) metaEl.textContent = `${metaEl.textContent.split(' · ')[0]} · ${msg.genStamp}`;
            }
            saveSessionsToMetadata();

            if (msg && streamMsgEl) {
                _renderMsgBodyContent(streamMsgEl, msg);
            }

            if (msg) {
                msg.swipes = [{ content: fullText, reasoning: fullReasoning || null }];
                msg.swipeIndex = 0;
                saveSessionsToMetadata();
            }
        } else {
            const newMsg = addMessage(session, 'assistant', fullText, { reasoning: fullReasoning || null, toolCalls: state.activeToolCalls.length ? JSON.parse(JSON.stringify(state.activeToolCalls)) : undefined });
            newMsg.genStamp = getGenStamp(settings) || undefined;
            newMsg.swipes = [{ content: fullText, reasoning: fullReasoning || null }];
            newMsg.swipeIndex = 0;
            saveSessionsToMetadata();
            appendMsgEl(newMsg);
        }

        _refreshSwipeBars(session);
        state.activeToolCalls = [];

        if (tokensIn > 0) recordStat(SM.tokIn, tokensIn);
        const tokensOut = await estimateTokens(fullText);
        if (tokensOut > 0) recordStat(SM.tokOut, tokensOut);

        playCompletionSound();
        _dbgAdd('GEN_DONE', { chars: fullText?.length || 0, hasReasoning: !!fullReasoning, tokensOut });

    } catch (err) {
        cleanupCursor();
        // Error path must drop the empty stream placeholder the same way the
        // result===null path does — otherwise an assistant message with
        // content:'' persists into the bucket on the next save.
        if (streamMsgId) {
            const idx = session.messages.findIndex(m => m.id === streamMsgId);
            // BUG-6: при обрыве соединения (чужой AbortError) частичный ответ
            // сохраняем как сообщение — паритет со Stop и watchdog, чтобы
            // настримленный текст не пропадал вместе с плейсхолдером.
            if (idx >= 0 && !session.messages[idx].content && streamAccumText) {
                session.messages[idx].content = streamAccumText;
                session.messages[idx].reasoning = streamAccumReasoning || null;
                saveSessionsToMetadata();
                if (streamContentEl) {
                    streamContentEl.innerHTML = renderMarkdown(streamAccumText);
                    postProcessHTMLBlocks(streamContentEl);
                }
            }
            // A throw in tool round >=2 leaves streamAccumText empty (it resets
            // each round), so the splice below would also drop the completed
            // rounds' text and their tool results — same contract as Stop.
            const salvageText = streamAccumText
                || (lastRoundPartialText ? accumulatedText + '\n\n' + lastRoundPartialText : accumulatedText);
            if (idx >= 0 && !session.messages[idx].content && salvageText) {
                session.messages[idx].content = salvageText;
                session.messages[idx].reasoning = accumulatedReasoning || null;
                saveSessionsToMetadata();
                if (streamContentEl) {
                    streamContentEl.innerHTML = renderMarkdown(salvageText);
                    postProcessHTMLBlocks(streamContentEl);
                }
            }
            if (idx >= 0 && !session.messages[idx].content) {
                session.messages.splice(idx, 1);
                streamMsgEl?.remove();
            }
        }
        if (!err?._stalled && (state.abortController?.signal?.aborted || state.generationStopped || err?.message === 'userStopped')) {
            if (myEpoch === state.genEpoch) {
                state.generating = false;
                setGeneratingState(false);
            }
            return;
        }

        const inputEl = document.getElementById('scp-input');
        if (inputEl && inputEl.value.trim() === '' && userText) {
            inputEl.value = userText;
        }

        _dbgAdd('GEN_ERROR', { msg: err?.message || String(err), stack: err?.stack, round: genToolRound, accumulatedChars: accumulatedText.length });
        console.error(`[${EXT_DISPLAY}] Generation failed:`, err);

        showGenerationError(err);
    } finally {
        // Сбой/стоп посреди tool-раунда: временные tool-сообщения вычищаем из
        // живой сессии — на диск они и так не попадают (_stripTempMessages),
        // но в памяти переживали ошибку и рендерились как обычные сообщения.
        if (session.messages?.some(m => m._tcTemp)) session.messages = session.messages.filter(m => !m._tcTemp);
        // Зомби-генерация (после смены чата) не трогает флаги новой генерации.
        if (myEpoch === state.genEpoch) {
            state.generating = false;
            setGeneratingState(false);
        }
    }
}

export function _joinContinuation(existing, continuation) {
    if (!continuation) return existing;
    const trimmed = existing.trimEnd();
    const needsSpace = /[\w.,!?;:'")\]}>]$/.test(trimmed);
    return trimmed + (needsSpace ? ' ' : '') + continuation;
}

export async function runContinue(session, targetMsgId) {
    _dbgAdd('CONTINUE_TRIGGERED', { targetMsgId });
    
    if (state.generating) return;
    const targetMsg = session.messages.find(m => m.id === targetMsgId);
    if (!targetMsg || targetMsg.role !== 'assistant') return;

    state.generating = true;
    state.generationStopped = false;
    const myEpoch = ++state.genEpoch;
    state.activeToolCalls = [];
    const settings = getEffectiveSettings();
    setGeneratingState(true);

    const CONTINUE_PROMPT = 'Continue your response exactly from where you left off. Do not repeat any previously written text.';

    let streamContentEl = null;
    let cursorEl = null;
    let isStreaming = false;
    let streamAccumContinuation = '';
    const originalContent = targetMsg.content;
    // RAF throttle (см. runGenerate для обоснования).
    let _contRafScheduled = false;
    let _contPendingText = null;
    let streamRenderer = null;

    const targetEl = document.querySelector(`.scp-msg[data-id="${targetMsgId}"]`);
    if (targetEl) streamContentEl = targetEl.querySelector('.scp-msg-content');

    const cleanupCursor = () => {
        // Аналогично runGenerate: сброс pending RAF при cleanup.
        _contRafScheduled = false;
        _contPendingText = null;
        if (streamRenderer) { streamRenderer.destroy(); streamRenderer = null; }
        if (cursorEl && cursorEl.parentNode) cursorEl.remove();
        cursorEl = null;
    };

    const _contFlush = (text) => {
        if (!cursorEl) {
            cursorEl = document.createElement('span');
            cursorEl.className = 'scp-stream-cursor';
            const bar = document.getElementById('scp-thinking-bar');
            if (bar) bar.style.display = 'flex';
        }
        if (!streamRenderer && streamContentEl) {
            streamRenderer = createStreamRenderer({ el: streamContentEl, preprocessed: true, onScroll: () => smartScrollToBottom() });
            streamRenderer.setCursor(cursorEl);
        }
        const combined = _joinContinuation(originalContent, text);
        let tcIndex = 0;
        let procText = /```memory-update/i.test(combined) ? stripMemoryBlock(combined) : combined;
        let resC = { text: procText, nextIndex: 0 };
        if (/```tool_call/i.test(procText)) {
            resC = extractToolCallPlaceholders(procText, tcIndex);
            procText = resC.text;
            tcIndex = resC.nextIndex;
        }

        const { content: disp } = getDisplayContent(procText, settings);
        if (streamRenderer) {
            streamRenderer.push(disp);

            if (resC.nextIndex > 0) {
                const liveTCs = parseToolCallsFromText(combined);
                const displayed = liveTCs.map((tc, i) => targetMsg.toolCalls?.[i] || {
                    id: `live_${i}`, name: tc.name, input: tc.input, status: 'done', result: undefined
                });
                postProcessToolCalls(targetEl, displayed);
            }
        }
        smartScrollToBottom();
    };

    const onChunk = (text) => {
        isStreaming = true;
        streamAccumContinuation = text;
        _contPendingText = text;
        if (!_contRafScheduled && streamContentEl) {
            _contRafScheduled = true;
            const schedule = (typeof requestAnimationFrame === 'function')
                ? requestAnimationFrame
                : (cb) => setTimeout(cb, 16);
            schedule(() => {
                _contRafScheduled = false;
                const t = _contPendingText;
                if (t == null) return;
                _contPendingText = null;
                _contFlush(t);
            });
        }
    };

    const _applyFinalContinuation = (fullCombined) => {
        const { content: disp } = getDisplayContent(fullCombined, settings);
        if (streamContentEl) { streamContentEl.innerHTML = renderMarkdown(disp); postProcessHTMLBlocks(streamContentEl); }
        _renderMsgBodyContent(targetEl, targetMsg);
    };

    try {
        const fullMessages = await assembleMessages(session, settings, CONTINUE_PROMPT);
        const fullPromptText = fullMessages.map(m => typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '')).join('\n');
        
        const tokensIn = await estimateTokens(fullPromptText);

        _dbgAdd('CONTINUE_START', {
            src: settings.connectionSource,
            maxTokens: settings.maxTokens,
            streaming: settings.forceStreaming,
            ctxDepth: settings.contextDepth,
            tokensIn
        });

        const result = await callGenerate(session, settings, CONTINUE_PROMPT, onChunk);
        cleanupCursor();

        if (result === null) {
            if (isStreaming && streamAccumContinuation) {
                const combined = _joinContinuation(originalContent, streamAccumContinuation);
                targetMsg.content = combined;
                if (targetMsg.swipes && targetMsg.swipeIndex !== undefined) {
                    targetMsg.swipes[targetMsg.swipeIndex] = { content: combined, reasoning: targetMsg.reasoning || null };
                }
                saveSessionsToMetadata();
                _applyFinalContinuation(combined);
            }
            return;
        }

        const { text: rawContinuation, isMaxTokens } = result;
        processMemoryUpdates(rawContinuation, targetMsgId);
        const continuation = stripMemoryBlock(rawContinuation);
        const combined = _joinContinuation(originalContent, continuation);
        
        if (isMaxTokens) {
            toastr.warning('Генерация остановлена: достигнут лимит максимальных токенов ответа.', EXT_DISPLAY, { timeOut: 10000 });
        }

        targetMsg.content = combined;

        if (targetMsg.swipes && targetMsg.swipeIndex !== undefined) {
            targetMsg.swipes[targetMsg.swipeIndex] = { content: combined, reasoning: targetMsg.reasoning || null };
        }
        saveSessionsToMetadata();
        _applyFinalContinuation(combined);

        if (tokensIn > 0) recordStat(SM.tokIn, tokensIn);
        
        const tokensOut = await estimateTokens(continuation);
        if (tokensOut > 0) recordStat(SM.tokOut, tokensOut);

        updateMsgCount(session);
        playCompletionSound();
        _dbgAdd('CONTINUE_DONE', { chars: continuation?.length || 0, tokensOut });

    } catch (err) {
        cleanupCursor();
        if (!err?._stalled && (state.abortController?.signal?.aborted || state.generationStopped || err?.message === 'userStopped')) {
            if (myEpoch === state.genEpoch) {
                state.generating = false;
                setGeneratingState(false);
            }
            return;
        }
        _dbgAdd('GEN_ERROR', { msg: err?.message || String(err), stack: err?.stack });
        console.error(`[${EXT_DISPLAY}] Continuation failed:`, err);

        showGenerationError(err);
    } finally {
        if (myEpoch === state.genEpoch) {
            state.generating = false;
            setGeneratingState(false);
        }
    }
}