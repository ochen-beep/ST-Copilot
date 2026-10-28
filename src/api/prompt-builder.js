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


export async function buildSystemContent(settings) {
    // Лёгкая синхронная подпись необходимых входов: быстрый FNV-1a над JSON(settings)
    // + чар/группа/имена + активный список WI-книг. Страхует от редких кейсов, когда
    // инвалидация не успела вызваться явным образом (см. invalidateSystemPromptCache).
    const curSig = _computeSystemPromptSignature(settings);

    const decision = decideSystemPromptCache(state, curSig);
    if (decision.useCache) {
        // Кэш хранит сам Promise<string>, возвращаем его без await — calling code
        // (assembleMessages)继续保持 `await buildSystemContent(...)` семантику.
        return state.systemPromptCache;
    }

    // miss — пересобираем, закэшируем Promise, чтобы конкурентные вызовы разделили работу.
    // Note: deliberately assign cache BEFORE awaiting inside promise — иначе второй
    // конкурентный вызов собрал бы свой Promise, и параллелизм терялся бы.
    const promise = (async () => {
        return _buildSystemContentInner(settings);
    })();

    state.systemPromptCache = promise;
    state.systemPromptSig = curSig;
    state.systemPromptDirty = false;

    // При отказе пересборки — не держать посетителей на закэшированном rejected Promise:
    // чистим кэш, чтобы следующий вызов попробовал снова (а не возвращал ту же ошибку).
    promise.catch(() => {
        // Только если это по-прежнему «наш» promise — иначе мы могли быть уже инвалидированы.
        if (state.systemPromptCache === promise) {
            invalidateSystemPromptCache('build-failure');
        }
    });

    return promise;
}

async function _buildSystemContentInner(settings) {
    let sysPromptRaw = (typeof settings.systemPrompt === 'string' && settings.systemPrompt.trim()) ? settings.systemPrompt : DEFAULT_SYSTEM_PROMPT;
    const parts = [_ensureWrapped(sysPromptRaw, 'system_prompt')];
    const charInfo = getCharInfo();
    const ctx = SillyTavern.getContext();

    if (settings.includeSystemPrompt) {
        // В st-context.js полей systemPrompt/system_prompt нет — мейн-промпт живёт
        // в настройках chat completion (oai_settings.system_prompt). Старые ключи
        // оставлены как fallback для гипотетических форков.
        const sp = ctx.chatCompletionSettings?.system_prompt
            || ctx.systemPrompt || ctx.system_prompt || '';
        if (sp) parts.push(`\n\n<st_system_prompt>\n${sp}\n</st_system_prompt>`);
    }

    if (ctx.groupId && ctx.groups) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        if (group && Array.isArray(group.members)) {
            const memberNames = group.members.map(m => {
                const c = ctx.characters.find(char => char.avatar === m);
                return c ? c.name : m;
            }).filter(Boolean);
            if (memberNames.length > 0) {
                parts.push(`\n<chat_group_members>\nThats chat with multiple characters. Current group members: ${memberNames.join(', ')}\n</chat_group_members>`);
            }
        }
    }

    const memoryBlock = buildMemoryContextBlock(settings)
    if (memoryBlock) parts.push(memoryBlock);

    const lbBlock = await buildLorebookContextBlock(settings);
    if (lbBlock) parts.push(lbBlock);

    {
    const editXml = buildCharacterContextBlock(settings);
    if (ctx.groupId) {
        if (editXml) parts.push('\n\n' + editXml);
    } else {
        let inner = `Name: ${charInfo ? charInfo.name : (ctx.name2 || 'Character')}\n`;
        if (editXml) inner += '\n' + editXml;
        parts.push(`\n\n<character_information>\n${inner}\n</character_information>`);
    }
}

    {
        const userName = ctx.name1 || 'User';
        let inner = `Name: ${userName}`;

        if (settings.includeUserPersonality) {
            let hasEvolutia = false;
            if (settings.useAspectEvolutia) {
                const aeUserFields = _getAspectEvolutiaPersonaFields();
                if (aeUserFields && aeUserFields.length) {
                    const aeContent = aeUserFields.map(f => `<evolutia_user_field name="${escHtml(f.name)}">\n${f.content}\n</evolutia_user_field>`).join('\n\n');
                    inner += `\n${aeContent}`;
                    hasEvolutia = true;
                }
            }
            if (!hasEvolutia) {
                const personaContent = getUserPersona();
                if (personaContent) inner += `\n${personaContent}`;
            }
        }
        parts.push(`\n\n<{{user}}_persona>\n${inner}\n</{{user}}_persona>`);
    }

    const aiInstructions = buildLBAIInstructions(settings).trim();
    const charEditDirective = buildCharEditAIInstructions(settings).trim();
    const chatEditDirective = buildChatEditAIInstructions(settings).trim();
    const memoryAIInstr = buildMemoryAIInstructions(settings).trim();
    const toolsBlock = buildToolCallsSystemBlock().trim();

    const modules = [memoryAIInstr, aiInstructions, charEditDirective, chatEditDirective, toolsBlock].filter(Boolean);
    if (modules.length > 0) {
        const reminder = `\n\n[SYSTEM REMINDER: If you intend to modify anything you MUST write the appropriate structured markdown block containing your instructions. The system strictly relies on these blocks to parse and apply your changes automatically. Simply describing your changes in plain text without outputting the corresponding markdown block will result in failure to apply them.]`;
        parts.push(`\n\n<modules>\n${modules.join('\n\n')}${reminder}\n</modules>`);
    }

    return parts.join('\n');
}

/**
 * Лёгкая синхронная подпись входов, влияющих на системный промпт.
 * Используется как страховка: сравнивается с прошлой подписью до возврата кэша
 * (см. decideSystemPromptCache). Чистая функция, экспортирована для тестов.
 */
export function _computeSystemPromptSignature(settings) {
    try {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : {};
        let activeWi = '';
        try {
            if (typeof window !== 'undefined' && Array.isArray(window.selected_world_info)) {
                activeWi = window.selected_world_info.join(',');
            }
        } catch (_) {}
        const charId = (ctx && ctx.characterId != null) ? String(ctx.characterId) : '';
        const groupId = (ctx && ctx.groupId != null) ? String(ctx.groupId) : '';
        const name1 = (ctx && ctx.name1 != null) ? String(ctx.name1) : '';
        const name2 = (ctx && ctx.name2 != null) ? String(ctx.name2) : '';
        // settings.stats mutate on every generation (recordStat) and never enter
        // the prompt: hashing them busts the cache each turn and masks real input
        // changes. Everything else in settings keeps its dirty-flag net.
        let settingsJson = '';
        if (settings && typeof settings === 'object') {
            const { stats, ...rest } = settings;
            settingsJson = JSON.stringify(rest);
        }
        // Live inputs read at build time with no invalidation hook of their own.
        const sysPrompt = (settings?.includeSystemPrompt && ctx.chatCompletionSettings?.system_prompt) || '';
        const persona = getUserPersona() || '';
        let groupMembers = '';
        if (groupId && Array.isArray(ctx.groups)) {
            const g = ctx.groups.find(gr => gr.id === ctx.groupId);
            if (g && Array.isArray(g.members)) groupMembers = g.members.join(',');
        }
        // roleplay_context / lorebook keyword scan read the live chat slice.
        let sliceSig = '';
        try {
            const depth = Math.max(0, parseInt(settings?.contextDepth) || 0);
            sliceSig = getMainChatSlice(depth).map(m => m.content).join('\u0000');
        } catch (_) {}
        return fnv1a32(`${charId}|${groupId}|${name1}|${name2}|${activeWi}|${sysPrompt}|${persona}|${groupMembers}|${sliceSig}|${settingsJson}`);
    } catch (_) {
        return '';
    }
}

export function _buildAiContextForHistoryMsg(msg) {
    try {
        const swipe = msg.swipes?.[msg.swipeIndex || 0];
        const lines = swipe?.historyLines || msg.appliedLines || [];
        const charName = swipe?._charName || msg._charName || null;

        const entries = lines.map(line => {
            const plain = line.replace(/\*\*/g, '').replace(/`/g, '');
            const statusMatch = plain.match(/^[✓✕·]\s+(ACCEPTED|REJECTED|DISMISSED[^:]*)/);
            const status = statusMatch ? statusMatch[1] : 'UNKNOWN';
            const restMatch = plain.match(/(?:ACCEPTED|REJECTED|DISMISSED[^:]*): (.+)/);
            const detail = restMatch ? restMatch[1].trim() : plain;
            return { status, detail };
        });

        const ctg = msg.isCharEditHistory ? 'character_card_changes' : (msg.isChatEditHistory ? 'chat_messages_edits' : 'lorebook_changes');
        const obj = { type: 'system_notification', category: ctg, entries };
        if (charName) obj.character = charName;

        return `${JSON.stringify(obj)}\n\n[System Note: \`${ctg}\` block deleted to save tokens. DO NOT regenerate it. Proceed with user's next request.]`;
    } catch (_) {
        return msg.content || '';
    }
}

export function getMainChatSlice(depth) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat) return [];
    
    const _incHidden = getEffectiveSettings().includeHiddenMessages;
    const extractData = (m, i) => ({
        role: m.is_user ? 'user' : 'assistant',
        name: m.is_user ? (ctx.name1 || 'User') : (m.name || getCharInfo()?.name || 'Character'),
        content: typeof m.mes === 'string' ? m.mes : '',
        chatIndex: i,
        is_hidden: (!_incHidden && (!!m.is_system || !!m.is_hidden || !!(m.extra && m.extra.is_hidden))) || !!(m.extra?.sc_ghosted)
    });

    try {
        const sess = getCurrentSession();
        const picked = sess.pickedChatIndices;
        if (picked && picked.length > 0) {
            return picked
                .filter(i => i >= 0 && i < ctx.chat.length)
                .map(i => extractData(ctx.chat[i], i));
        }
    } catch(_) {}
    
    if (depth === 0) return [];
    const total = ctx.chat.length;
    return ctx.chat.slice(-depth).map((m, i) => extractData(m, total - depth + i));
}

export async function assembleMessages(session, settings, pendingUserText, pendingAtts = null) {
    const messages = [{ role: 'system', content: await buildSystemContent(settings) }];
    const depth = Math.max(0, parseInt(settings.contextDepth) || 0);
    const hasPicked = !!(session.pickedChatIndices && session.pickedChatIndices.length > 0);
    
    if (depth > 0 || hasPicked) {
        const slice = getMainChatSlice(depth);
        if (slice.length) {
            const chatTotal = SillyTavern.getContext().chat?.length ?? 0;
            const processedSlice = await Promise.all(slice.map(async m => ({
                ...m, content: await applyRegexIfEnabled(m.content, m.role === 'user', chatTotal - m.chatIndex - 1),
            })));
            const ctx = SillyTavern.getContext();
            const visibleSlice = processedSlice.filter(m => !m.is_hidden);

            if (settings.includeAlternateSwipes && visibleSlice.length > 0) {
                let lastAstMsg = null;
                for (let i = visibleSlice.length - 1; i >= 0; i--) {
                    if (visibleSlice[i].role === 'assistant') {
                        lastAstMsg = visibleSlice[i];
                        break;
                    }
                }
                if (lastAstMsg) {
                    const stChatMsg = ctx.chat[lastAstMsg.chatIndex];
                    if (stChatMsg && Array.isArray(stChatMsg.swipes) && stChatMsg.swipes.length > 1) {
                        let swipesXml = '<alternate_swipes>\n';
                        const activeSwipeId = stChatMsg.swipe_id ?? 0;
                        stChatMsg.swipes.forEach((sw, idx) => {
                            if (idx === activeSwipeId) return;
                            const text = typeof sw === 'string' ? sw : (sw.mes || '');
                            if (text) swipesXml += `<swipe index="${idx}">\n${text}\n</swipe>\n`;
                        });
                        swipesXml += '</alternate_swipes>\n';
                        lastAstMsg.content = swipesXml + lastAstMsg.content;
                    }
                }
            }

            const block = visibleSlice.map(m => {
                return `<msg index="${m.chatIndex}" role="${m.role === 'user' ? 'user' : 'assistant'}">\n${m.content}\n</msg>`;
            }).join('\n\n');
            
            let summaryText = '';
            if (settings.includeSummaryception !== false) {
                const scSummary = _getSummaryceptionSummary();
                if (scSummary) summaryText = `\n<summary_context>\n${scSummary}\n</summary_context>\n\n`;
            }

            const ctxAttr = hasPicked ? `picked_messages="${visibleSlice.length}"` : `last_messages="${visibleSlice.length}"`;
            messages.push({
                role: 'user',
                content: `<roleplay_context ${ctxAttr}>\n${summaryText}${block}\n\n</roleplay_context>`,
            });
            messages.push({ role: 'assistant', content: 'Understood. I have reviewed the current roleplay context. How can I help?' });
        }
    }
    const limit = Math.max(1, parseInt(settings.localHistoryLimit) || 50);
    for (const m of session.messages.slice(-limit)) {
        let content = m.content;
        
        const currentSwipe = m.swipes?.[m.swipeIndex || 0];
        const hasAttachedHistory = currentSwipe?.historyLines?.length > 0;

        if (m.isLBHistory || m.isCharEditHistory || m.isChatEditHistory) {
            content = _buildAiContextForHistoryMsg(m);
            messages.push({ role: 'user', content: _mergeContent(content, m.attachments) });
        } else {
            const finalContent = _mergeContent(content, m.attachments);
            let apiRole = m.role;
            if (apiRole === 'system') apiRole = 'user';

            const outMsg = { role: apiRole, content: finalContent };
            // Нативные tool-раунды: assistant.tool_calls и role:'tool' идут в API как есть
            if (m.tool_calls) outMsg.tool_calls = m.tool_calls;
            if (m.tool_call_id) outMsg.tool_call_id = m.tool_call_id;
            messages.push(outMsg);

            if (hasAttachedHistory) {
                let cat = 'system_action_results';
                const firstLine = currentSwipe.historyLines[0] || '';
                if (firstLine.includes('Character') || firstLine.includes('Tags') || firstLine.includes('Description') || firstLine.includes('Personality')) cat = 'character_card_changes';
                else if (firstLine.includes('message')) cat = 'chat_messages_edits';
                else cat = 'lorebook_changes';

                const dummy = { appliedLines: currentSwipe.historyLines, isCharEditHistory: cat === 'character_card_changes', isChatEditHistory: cat === 'chat_messages_edits' };
                const historyContext = _buildAiContextForHistoryMsg(dummy);
                
                messages.push({ role: 'user', content: historyContext });
            }
        }
    }
    if (pendingUserText !== null && pendingUserText !== undefined) {
        const finalContent = _mergeContent(pendingUserText, pendingAtts);
        if (finalContent || (Array.isArray(finalContent) && finalContent.length)) {
            messages.push({ role: 'user', content: finalContent });
        }
    }

    for (let m of messages) {
        if (typeof m.content === 'string') {
            m.content = await expandOutletsAsync(m.content);
        } else if (Array.isArray(m.content)) {
            for (let part of m.content) {
                if (part.type === 'text') {
                    part.text = await expandOutletsAsync(part.text);
                }
            }
        }
    }

    return messages;
}

export function formatPayloadAsText(messages) {
    return messages.map(m => {
        const label = m.role === 'system' ? '■ SYSTEM' : m.role === 'user' ? '▶ USER' : '◀ ASSISTANT';
        let c = m.content;
        if (Array.isArray(c)) {
            c = c.map(part => {
                if (part.type === 'text') return part.text;
                if (part.type === 'image_url') return `[Image Base64 Attached]`;
                return `[Unknown Block]`;
            }).join('\n');
        }
        return `${label}\n${'─'.repeat(50)}\n${c}`;
    }).join('\n\n');
}

export async function estimateTokens(text) {
    if (!text) return 0;
    let str = text;
    if (Array.isArray(text)) {
        str = text.map(t => t.type === 'text' ? t.text : '').join('\n');
    }

    // Используем компактный хэш-ключ вместо полной строки-промпта
    // (для типового промпта в 20k символов это экономит ~5MB+ памяти на 500 кэш-записей).
    const key = cacheKey(str);

    if (state.tokenCountCache.has(key)) return state.tokenCountCache.get(key);
    if (state.tokenCountPromises.has(key)) return state.tokenCountPromises.get(key);

    const promise = (async () => {
        const ctx = SillyTavern.getContext();

        try {
            if (typeof ctx.getTokenCountAsync === 'function') return await ctx.getTokenCountAsync(str);
            if (typeof window.getTokenCountAsync === 'function') return await window.getTokenCountAsync(str);
        } catch (_) {}

        await new Promise(resolve => setTimeout(resolve, 0));

        try {
            if (typeof ctx.getTokenCount === 'function') return ctx.getTokenCount(str);
            if (typeof window.getTokenCount === 'function') return window.getTokenCount(str);
        } catch (_) {}

        try {
            const res = await fetch('/api/tokencount', {
                method: 'POST',
                headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: str })
            });
            if (res.ok) {
                const data = await res.json();
                if (typeof data.length === 'number') return data.length;
                if (typeof data.count === 'number') return data.count;
                if (typeof data === 'number') return data;
            }
        } catch (_) {}

        return Math.ceil(str.length / 3.5);
    })();

    state.tokenCountPromises.set(key, promise);
    try {
        const count = await promise;
        if (state.tokenCountCache.size > 500) {
            const keysToDel = Array.from(state.tokenCountCache.keys()).slice(0, 100);
            keysToDel.forEach(k => state.tokenCountCache.delete(k));
        }
        state.tokenCountCache.set(key, count);
        return count;
    } finally {
        state.tokenCountPromises.delete(key);
    }
}

// Патчим только собственные генерационные эндпоинты ST: любой другой код
// (основной чат, другие расширения), чей запрос попадёт в окно патча, не должен
