import { EXT_DISPLAY, I, THEME_PRESETS } from '../constants.js';
import { state } from '../state.js';
import { getSettings, saveSettings, getCurrentSession, saveSessionsToMetadata, deleteMsg, truncateAfter, truncateFrom, expandMacros, getEffectiveSettings, getBindingKey, initChatBucket, isMessageStarred, toggleStarMessage } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { escHtml, autoResize, showCustomDialog, copyText } from '../utils/util-dom.js';
import { getCharInfo } from '../utils/util-st.js';

import { parseLBChangesFromText, stripLBChangesBlock } from '../features/feature-lorebook-engine.js';
import { renderProposalCard, appendLBHistoryEl } from '../features/feature-lorebook-ui.js';
import { parseCharChangesFromText, stripCharChangesBlock, parseCharCreationFromText, stripCharCreationBlock } from '../features/feature-character-engine.js';
import { renderCharProposalCard, renderCharCreationCard } from '../features/feature-character-ui.js';
import { normalizeCharNamesInBlock } from '../utils/util-text.js';
import { cacheKey } from '../utils/util-hash.js';
import { discoverProposalBlocks } from '../utils/util-block-discovery.js';
import { createStreamRenderer } from './render/stream-renderer.js';
import { computeRenderFrom } from './render/render-window.js';
import { parseChatChangesFromText, stripChatChangesBlock } from '../features/feature-chatedit-engine.js';
import { renderChatProposalCard } from '../features/feature-chatedit-ui.js';
import { stripMemoryBlock } from '../features/feature-memory.js';
import { parseToolCallsFromText } from '../features/feature-tools-engine.js';
import { postProcessToolCalls } from '../features/feature-tools-ui.js';
import { recordStat, SM } from '../features/feature-stats.js';
import { _openImageLightbox, _openTextLightbox } from '../features/feature-attachments.js';

import { apiMod, uiWinMod, uiWdgMod, uiSetMod, featCharUiMod } from './chat-shared.js';
import { renderMarkdown, postProcessHTMLBlocks, getDisplayContent, extractToolCallPlaceholders, _renderMsgBodyContent, _updateMsgTokenCount } from './render-msg.js';
import { renderSession, removeMsgEl, removeMsgElAndBelow, removeMsgElAfter, updateMsgCount, setGeneratingState, showGenerationError, appendMsgEl } from './session-view.js';
export function getLastAssistantMsgId(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role === 'user') return null;
        if (m.role === 'assistant' && !m.isLBHistory && !m.isCharEditHistory && !m.isChatEditHistory) {
            return m.id;
        }
    }
    return null;
}

export function getSwipesForMsg(session, msgId) {
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return null;
    if (!msg.swipes) msg.swipes = [{ content: msg.content, reasoning: msg.reasoning || null }];
    if (msg.swipeIndex === undefined) msg.swipeIndex = 0;
    return msg;
}

export function navigateSwipe(session, msgId, dir) {
    const msg = getSwipesForMsg(session, msgId);
    if (!msg || msg.swipes.length < 2) return false;
    const newIdx = msg.swipeIndex + dir;
    if (newIdx < 0 || newIdx >= msg.swipes.length) return false;

    _dbgAdd('SWIPE_NAVIGATE', { msgId, dir, newIdx });

    msg.swipeIndex = newIdx;
    msg.content = msg.swipes[newIdx].content;
    msg.reasoning = msg.swipes[newIdx].reasoning || null;
    saveSessionsToMetadata();
    updateMsgCount(session);
    return true;
}

export function updateSwipeBar(msgEl, session, msgId) {
    const bar = msgEl.querySelector('.scp-swipe-bar');
    if (!bar) return;
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.swipes) {
        msg.swipes = [{ content: msg.content, reasoning: msg.reasoning || null }];
        msg.swipeIndex = 0;
    }
    const total = msg.swipes.length;
    const cur = (msg.swipeIndex ?? 0) + 1;
    const prevBtn = bar.querySelector('.scp-swipe-prev');
    const nextBtn = bar.querySelector('.scp-swipe-next');
    const counter = bar.querySelector('.scp-swipe-counter');
    const delBtn = bar.querySelector('.scp-swipe-del');
    if (prevBtn) prevBtn.disabled = cur <= 1 || state.generating;
    if (nextBtn) nextBtn.disabled = state.generating;
    if (delBtn) delBtn.disabled = total < 2 || state.generating;
    if (counter) counter.innerHTML = `<span>${cur}</span>/${total}`;
    bar.style.display = '';
}

export async function _runSwipeRegen(session, msgId, wrapEl) {
    if (state.generating) return;
    const msgData = session.messages.find(m => m.id === msgId);
    if (!msgData) return;

    if (!msgData.swipes) {
        msgData.swipes = [{ content: msgData.content, reasoning: msgData.reasoning || null }];
        msgData.swipeIndex = 0;
    }

    state.generating = true;
    // Same reset as runGenerate/runContinue: a stale flag from a previously
    // stopped generation suppresses the stall-watchdog error for this regen.
    state.generationStopped = false;
    state.activeToolCalls = [];
    // Эпоха генерации — как в runGenerate: зомби-реген после смены чата не должен
    // снимать флаги уже начавшейся новой генерации в своём finally.
    const myEpoch = ++state.genEpoch;
    const settings = getEffectiveSettings();
    setGeneratingState(true);

    const body = wrapEl.querySelector('.scp-msg-body');
    if (body) {
        body.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
        body.classList.add('scp-swipe-anim-out-left');
        await new Promise(r => setTimeout(r, 150));
    }

    const placeholderContent = '';
    msgData.swipes.push({ content: placeholderContent, reasoning: null });
    msgData.swipeIndex = msgData.swipes.length - 1;
    msgData.content = placeholderContent;
    msgData.reasoning = null;
    saveSessionsToMetadata();

    updateSwipeBar(wrapEl, session, msgId);

    let streamContentEl = wrapEl.querySelector('.scp-msg-content');
    if (streamContentEl) streamContentEl.innerHTML = '';
    const rBlock = wrapEl.querySelector('.scp-reasoning-block');
    if (rBlock) rBlock.style.display = 'none';
    
    wrapEl.querySelectorAll('.scp-lb-proposal-card').forEach(c => c.remove());
    wrapEl.querySelectorAll('.scp-msg-hist-wrap').forEach(c => c.remove());

    if (body) {
        body.classList.remove('scp-swipe-anim-out-left');
        void body.offsetWidth;
        body.classList.add('scp-swipe-anim-right');
    }

    let cursorEl = null;
    const cleanupCursor = () => {
        // Сброс pending RAF (см. api.js — тот же мотив).
        _regenRafScheduled = false;
        _regenPendingArgs = null;
        if (streamRenderer) { streamRenderer.destroy(); streamRenderer = null; }
        if (cursorEl?.parentNode) cursorEl.remove();
        cursorEl = null;
    };
    // RAF throttle стриминга (см. runGenerate в api.js — тот же приём).
    let _regenRafScheduled = false;
    let _regenPendingArgs = null;
    let streamRenderer = null;

    const _regenFlush = (text, reasoning) => {
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
        if (streamContentEl) {
            let procReasoning = reasoning || '';
            let procText = /```memory-update/i.test(text) ? stripMemoryBlock(text) : text;
            let tcIndex = 0;

            // Контент первым: toolCalls соответствуют фенсам контента (см. _renderMsgBodyContent).
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

            const { content: disp } = getDisplayContent(procText, settings);
            if (streamRenderer) streamRenderer.push(disp);

            if (tcIndex > 0) {
                const liveTCs = parseToolCallsFromText(text + '\n' + (reasoning || ''));
                const displayed = liveTCs.map((tc, i) => ({
                    id: `live_${i}`, name: tc.name, input: tc.input, status: 'done', result: undefined
                }));
                postProcessToolCalls(wrapEl, displayed);
            }
        }
        smartScrollToBottom();
    };

    const onChunk = (text, reasoning) => {
        _regenPendingArgs = { text, reasoning };
        if (!_regenRafScheduled && streamContentEl) {
            _regenRafScheduled = true;
            const schedule = (typeof requestAnimationFrame === 'function')
                ? requestAnimationFrame
                : (cb) => setTimeout(cb, 16);
            schedule(() => {
                _regenRafScheduled = false;
                const args = _regenPendingArgs;
                if (!args) return;
                _regenPendingArgs = null;
                _regenFlush(args.text, args.reasoning);
            });
        }
    };

    try {
        const tempSession = { ...session, messages: session.messages.filter(m => m.id !== msgId) };
        if (!apiMod) throw new Error("API module not loaded");
        
        const builtMessages = await apiMod.assembleMessages(tempSession, settings, null);
        // Same text-only flattening as runGenerate: array content (attachments)
        // would string-join as "[object Object]" and poison the token cache.
        const fullPromptText = builtMessages.map(m => typeof m.content === 'string' ? m.content
            : (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '')).join('\n');
        const tokensIn = await apiMod.estimateTokens(fullPromptText);

        const result = await apiMod.callGenerate(tempSession, settings, null, onChunk);
        cleanupCursor();

        if (result === null) {
            msgData.swipes.pop();
            msgData.swipeIndex = msgData.swipes.length - 1;
            msgData.content = msgData.swipes[msgData.swipeIndex]?.content || '';
            msgData.reasoning = msgData.swipes[msgData.swipeIndex]?.reasoning || null;
            saveSessionsToMetadata();
            _renderMsgBodyContent(wrapEl, msgData);
            updateSwipeBar(wrapEl, session, msgId);
            return;
        }

        const { text: rawText, reasoning: fullReasoning } = result;
        const fullText = normalizeCharNamesInBlock(rawText);

        msgData.swipes[msgData.swipeIndex] = { content: fullText, reasoning: fullReasoning || null };
        msgData.content = fullText;
        msgData.reasoning = fullReasoning || null;
        saveSessionsToMetadata();

        _renderMsgBodyContent(wrapEl, msgData);
        updateSwipeBar(wrapEl, session, msgId);

        if (tokensIn > 0) recordStat(SM.tokIn, tokensIn);
        const tokensOut = await apiMod.estimateTokens(fullText);
        if (tokensOut > 0) recordStat(SM.tokOut, tokensOut);
        recordStat(SM.regen);
        updateMsgCount(session);
        if (uiWdgMod) uiWdgMod.playCompletionSound();

    } catch(err) {
        cleanupCursor();
        msgData.swipes.pop();
        msgData.swipeIndex = msgData.swipes.length - 1;
        msgData.content = msgData.swipes[msgData.swipeIndex]?.content || '';
        msgData.reasoning = msgData.swipes[msgData.swipeIndex]?.reasoning || null;
        saveSessionsToMetadata();
        _renderMsgBodyContent(wrapEl, msgData);
        updateSwipeBar(wrapEl, session, msgId);

        if (state.abortController?.signal?.aborted || err?.message === 'userStopped') {} 
        else { showGenerationError(err); }
    } finally {
        if (myEpoch === state.genEpoch) {
            state.generating = false;
            setGeneratingState(false);
        }
    }
}

export function _refreshSwipeBars(session) {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    c.querySelectorAll('.scp-swipe-bar').forEach(bar => { bar.style.display = 'none'; });
    if (state.generating) return;
    const lastId = getLastAssistantMsgId(session);
    if (!lastId) return;
    const lastEl = c.querySelector(`.scp-msg[data-id="${lastId}"]`);
    if (!lastEl) return;
    const swipeBar = lastEl.querySelector('.scp-swipe-bar');
    if (!swipeBar) return;
    updateSwipeBar(lastEl, session, lastId);
    swipeBar.style.display = '';
}

export function _refreshContinueBtns() {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    c.querySelectorAll('.scp-msg-last-assistant').forEach(el => el.classList.remove('scp-msg-last-assistant'));
    if (state.generating) return;
    const all = [...c.querySelectorAll('.scp-msg-assistant')];
    if (all.length) all[all.length - 1].classList.add('scp-msg-last-assistant');
}

// ─── Scroll ──────────────────────────────────────────────────────────────────

export function scrollToBottom() {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    state.userScrolledUp = false;
    
    // Делаем несколько попыток скролла, если окно еще не отрендерилось (например, при загрузке страницы)
    const tryScroll = (attempts = 0) => {
        if (c.offsetHeight > 0) {
            c.scrollTop = c.scrollHeight;
        } else if (attempts < 5) {
            setTimeout(() => tryScroll(attempts + 1), 50);
        }
    };
    tryScroll();
}

export function saveScrollPosition() {
    const c = document.getElementById('scp-messages');
    // Сохраняем позицию ТОЛЬКО если окно сейчас открыто и отрендерено
    if (c && c.offsetHeight > 0) {
        state.savedScrollTop = c.scrollTop;
    }
}

export function restoreScrollPosition() {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    
    const tryRestore = (attempts = 0) => {
        if (c.offsetHeight > 0) {
            if (state.userScrolledUp && state.savedScrollTop !== undefined) {
                c.scrollTop = state.savedScrollTop;
            } else {
                c.scrollTop = c.scrollHeight;
            }
        } else if (attempts < 5) {
            setTimeout(() => tryRestore(attempts + 1), 50);
        }
    };
    tryRestore();
}

export function smartScrollToBottom() {
    if (state.userScrolledUp) return;
    const c = document.getElementById('scp-messages');
    if (c) c.scrollTop = c.scrollHeight;
}

export function setupMessagesScrollTracking() {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    c.addEventListener('scroll', () => {
        state.userScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 80;
    }, { passive: true });
}

/**
 * Копирование блоков кода одним делегированным обработчиком.
 *
 * Делегирование обязательно: кнопки создаются строкой в renderMarkdown и
 * пересоздаются на каждом `innerHTML =` (стриминг, свайпы, правка сообщения),
 * поэтому прямой addEventListener на кнопку терялся бы вместе с узлом.
 * Текст берём из textContent <code> — сущности уже распарсены браузером,
 * а подсветка поиска оборачивает совпадения в <mark>, не меняя textContent.
 */
export function setupCodeBlockActions() {
    const c = document.getElementById('scp-messages');
    if (!c || c.dataset.scpCodeActionsBound) return;
    c.dataset.scpCodeActionsBound = '1';

    c.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('.scp-code-copy-btn') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();

        const codeEl = btn.closest('.scp-code-block-wrap')?.querySelector('.scp-code-block code');
        if (!codeEl) return;
        copyText(codeEl.textContent);

        const label = btn.querySelector('span');
        if (!label) return;
        const prev = label.textContent;
        label.textContent = 'Скопировано';
        btn.classList.add('copied');
        // К следующему чанку стрима узла может уже не быть в DOM — таймер при этом
        // отрабатывает вхолостую, поэтому просто проверяем isConnected.
        setTimeout(() => {
            if (!btn.isConnected) return;
            label.textContent = prev;
            btn.classList.remove('copied');
        }, 1200);
    });
}

// ─── Message List and Handlers ──────────────────────────────────────────

export function addHistoryToSwipe(msgId, newLines, charName = null) {
    if (!msgId) return false;
    const session = getCurrentSession();
    const msg = session.messages.find(m => m.id === msgId);
    if (!msg) return false;
    if (!msg.swipes) msg.swipes = [{ content: msg.content, reasoning: msg.reasoning }];
    const currentSwipe = msg.swipes[msg.swipeIndex || 0];
    if (!currentSwipe.historyLines) currentSwipe.historyLines = [];
    currentSwipe.historyLines.push(...newLines);
    if (charName && !currentSwipe._charName) currentSwipe._charName = charName;
    saveSessionsToMetadata();
    
    const msgEl = document.querySelector(`.scp-msg[data-id="${msgId}"]`);
    if (msgEl) {
        let body = msgEl.querySelector('.scp-msg-body');
        if (body) {
            let histWrap = body.querySelector('.scp-msg-hist-wrap');
            if (!histWrap) {
                histWrap = document.createElement('div');
                histWrap.className = 'scp-msg-hist-wrap';
                body.appendChild(histWrap);
            }
            const dummyMsg = { appliedLines: currentSwipe.historyLines };
            const contentEl = document.createElement('div');
            contentEl.className = 'scp-msg-content scp-lb-history-content';
            contentEl.style.marginTop = '10px';
            contentEl.style.padding = '8px 12px';
            contentEl.style.background = 'var(--scp-accent-bg)';
            contentEl.style.border = '1px solid var(--scp-accent-dim)';
            contentEl.style.borderRadius = '6px';
            
            import('../features/feature-lorebook-ui.js').then(m => {
                m.renderLBHistoryContent(dummyMsg, contentEl);
                histWrap.innerHTML = '';
                histWrap.appendChild(contentEl);
            });

            const swipeBar = body.querySelector('.scp-swipe-bar');
            if (swipeBar) body.insertBefore(histWrap, swipeBar);
            else body.appendChild(histWrap);
        }
    }
    return true;
}

export function handleCopy(msg) { copyText(msg.content); }

export function handleEdit(wrapEl, msg) {
    if (wrapEl.classList.contains('is-editing')) return;
    // The streaming epilogue writes msg.content and re-renders the body on
    // completion — an edit made mid-generation would be silently clobbered.
    if (state.generating) { toastr.info('Дождитесь завершения генерации.', EXT_DISPLAY); return; }
    wrapEl.classList.add('is-editing');
    const { charId, chatId } = getBindingKey();
    const session = getCurrentSession();
    const contentEl = wrapEl.querySelector('.scp-msg-content');
    const original = msg.content;

    const ta = document.createElement('textarea');
    ta.className = 'scp-edit-ta';
    ta.value = original;

    const row = document.createElement('div');
    row.className = 'scp-edit-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'scp-edit-btn scp-edit-save';
    saveBtn.innerHTML = msg.role === 'user'
        ? `${I.check}<span>Сохранить и отправить</span>`
        : `${I.check}<span>Сохранить</span>`;

    const saveOnlyBtn = msg.role === 'user' ? document.createElement('button') : null;
    if (saveOnlyBtn) {
        saveOnlyBtn.className = 'scp-edit-btn scp-edit-cancel';
        saveOnlyBtn.innerHTML = `${I.check}<span>Сохранить</span>`;
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'scp-edit-btn scp-edit-cancel';
    cancelBtn.innerHTML = `${I.x}<span>Отмена</span>`;

    row.appendChild(saveBtn);
    if (saveOnlyBtn) row.appendChild(saveOnlyBtn);
    row.appendChild(cancelBtn);
    contentEl.replaceWith(ta);
    wrapEl.querySelector('.scp-msg-actions').after(row);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    autoResize(ta); ta.addEventListener('input', () => autoResize(ta));

    // Правка reasoning у ответов reasoning-моделей — отдельным полем под ответом.
    let reasonTa = null;
    if (msg.role !== 'user' && msg.reasoning) {
        const rl = document.createElement('div');
        rl.className = 'scp-edit-reason-label';
        rl.textContent = 'Размышления (reasoning):';
        reasonTa = document.createElement('textarea');
        reasonTa.className = 'scp-edit-ta scp-edit-reason-ta';
        reasonTa.value = msg.reasoning;
        ta.after(rl); rl.after(reasonTa);
        autoResize(reasonTa); reasonTa.addEventListener('input', () => autoResize(reasonTa));
    }

    const applyReasoningEdit = () => {
        if (!reasonTa) return;
        msg.reasoning = reasonTa.value.trim() || null;
        if (msg.swipes && msg.swipeIndex !== undefined) msg.swipes[msg.swipeIndex].reasoning = msg.reasoning;
        const rBlock = wrapEl.querySelector('.scp-reasoning-block');
        if (!msg.reasoning) { rBlock?.remove(); return; }
        let rc = null;
        if (rBlock) {
            rc = rBlock.querySelector('.scp-reasoning-content');
            rc.innerHTML = renderMarkdown(msg.reasoning);
        } else {
            const nb = document.createElement('details');
            nb.className = 'scp-reasoning-block';
            nb.innerHTML = `<summary class="scp-reasoning-summary">Размышления</summary><div class="scp-reasoning-content"></div>`;
            rc = nb.querySelector('.scp-reasoning-content');
            rc.innerHTML = renderMarkdown(msg.reasoning);
            const body = wrapEl.querySelector('.scp-msg-body');
            const contentNow = wrapEl.querySelector('.scp-msg-content');
            if (body && contentNow) body.insertBefore(nb, contentNow);
        }
        // Without this, an ```html fence in edited reasoning renders as a bare
        // placeholder div and its htmlBlockRegistry entry is never consumed.
        postProcessHTMLBlocks(rc);
    };

    const restoreMessageDOM = (textToRender) => {
        const nc = document.createElement('div');
        nc.className = 'scp-msg-content';

        // Однопроходное обнаружение proposal-блоков. Важное отличие от createMsgEl:
        // здесь каждая ветка всё равно делает `.remove()` устаревшей карточки, если
        // блок отсутствует, поэтому мы обязательно вызываем парсер по флагу
        // (результат может быть null/[]), а не skip целиком — это сохраняет cleanup.
        const flags = discoverProposalBlocks(textToRender);
        const lbChanges = flags.lb ? parseLBChangesFromText(textToRender) : null;
        const charChanges = flags.char ? parseCharChangesFromText(textToRender) : null;
        const charCreation = flags.charCreate ? parseCharCreationFromText(textToRender) : null;
        const chatChanges = flags.chat ? parseChatChangesFromText(textToRender) : null;
        let stripped = textToRender;
        
        if (lbChanges?.length) { 
            stripped = stripLBChangesBlock(stripped); 
            renderProposalCard(lbChanges, wrapEl); 
        } else document.querySelector(`.scp-lb-proposal-card[data-for="${msg.id}"]`)?.remove();
        
        if (charChanges?.length) { 
            stripped = stripCharChangesBlock(stripped); 
            renderCharProposalCard(charChanges, wrapEl); 
        } else document.querySelectorAll(`.scp-char-proposal-card[data-for="${msg.id}"]`).forEach(c => c.remove());
        
        if (charCreation) { 
            stripped = stripCharCreationBlock(stripped); 
            renderCharCreationCard(charCreation, wrapEl); 
        } else document.querySelector(`.scp-char-creation-card[data-for="${msg.id}"]`)?.remove();

        if (chatChanges?.length) { 
            stripped = stripChatChangesBlock(stripped); 
            renderChatProposalCard(chatChanges, wrapEl); 
        } else document.querySelector(`.scp-chat-proposal-card[data-for="${msg.id}"]`)?.remove();
        
        let tcIndex = 0;
        const resR = extractToolCallPlaceholders(stripped, tcIndex);
        const displayString = getDisplayContent(resR.text, getSettings()).content;

        nc.innerHTML = renderMarkdown(displayString);
        postProcessHTMLBlocks(nc);
        ta.replaceWith(nc);
        row.remove();
        wrapEl.classList.remove('is-editing');
        // Same fallback as _renderMsgBodyContent: messages without persisted
        // toolCalls (older/imported) keep their cards via the flat re-parse,
        // otherwise cancel/save leaves empty placeholder divs.
        let liveTCs = msg.toolCalls;
        if ((!liveTCs || !liveTCs.length) && resR.nextIndex > 0) {
            liveTCs = parseToolCallsFromText((msg.content || '') + '\n' + (msg.reasoning || '')).map((tc, i) => ({
                id: `past_${i}`, name: tc.name, input: tc.input, status: 'done', result: 'Result hidden/expired'
            }));
        }
        if (liveTCs?.length) postProcessToolCalls(wrapEl, liveTCs);
    };

    cancelBtn.addEventListener('click', () => {
        restoreMessageDOM(original);
    });

    if (saveOnlyBtn) {
        saveOnlyBtn.addEventListener('click', () => {
            const rawText = ta.value.trim();
            if (!rawText) return;
            const newText = expandMacros(rawText);
            
            const msgObj = session.messages.find(m => m.id === msg.id);
            if (msgObj) { msgObj.content = newText; saveSessionsToMetadata(); }
            
            msg.content = newText;
            if (msg.swipes && msg.swipeIndex !== undefined) {
                msg.swipes[msg.swipeIndex] = { ...msg.swipes[msg.swipeIndex], content: newText, reasoning: msg.reasoning || null };
                saveSessionsToMetadata();
            }
            recordStat(SM.edit);
            restoreMessageDOM(newText);
            applyReasoningEdit();
            _updateMsgTokenCount(wrapEl, newText, true);
        });
    }

    saveBtn.addEventListener('click', async () => {
        const rawText = ta.value.trim();
        if (!rawText) return;
        const newText = expandMacros(rawText);
        
        const msgObj = session.messages.find(m => m.id === msg.id);
        if (msgObj) { msgObj.content = newText; saveSessionsToMetadata(); }

        msg.content = newText;
        if (msg.swipes && msg.swipeIndex !== undefined) {
            msg.swipes[msg.swipeIndex] = { ...msg.swipes[msg.swipeIndex], content: newText, reasoning: msg.reasoning || null };
            saveSessionsToMetadata();
        }
        recordStat(SM.edit);
        restoreMessageDOM(newText);
        applyReasoningEdit();
        _updateMsgTokenCount(wrapEl, newText, true);

        truncateAfter(session, msg.id);
        removeMsgElAfter(msg.id);
        if (msg.role === 'user' && apiMod) await apiMod.runGenerate(session, newText, false);
    });
}

export async function handleMessageRegen(wrapEl, msg) {
    if (state.generating) return;
    const session = getCurrentSession();
    const idx = session.messages.findIndex(m => m.id === msg.id);
    if (idx === -1) return;

    const isUser = msg.role === 'user';
    const actualMsgsAfter = session.messages.slice(idx + 1).filter(m => !m.isLBHistory && !m.isCharEditHistory && !m.isChatEditHistory);
    const msgsAfterCount = actualMsgsAfter.length;

    let needsConfirm = false;
    if (isUser) {
        if (msgsAfterCount > 1 || (msgsAfterCount === 1 && actualMsgsAfter[0].role !== 'assistant')) {
            needsConfirm = true;
        }
    } else {
        if (msgsAfterCount > 0) {
            needsConfirm = true;
        }
    }

    if (needsConfirm) {
        const ok = await showCustomDialog({
            type: 'confirm',
            title: 'Перегенерировать сообщение',
            message: 'Перегенерация удалит все последующие сообщения. Продолжить?'
        });
        if (!ok) return;
    }

    if (isUser) {
        truncateAfter(session, msg.id);
        removeMsgElAfter(msg.id);
        updateMsgCount(session);
        recordStat(SM.regen);
        if (apiMod) apiMod.runGenerate(session, null, false);
    } else {
        if (msgsAfterCount > 0) {
            truncateAfter(session, msg.id);
            removeMsgElAfter(msg.id);
            updateMsgCount(session);
        }
        recordStat(SM.regen);
        _runSwipeRegen(session, msg.id, wrapEl);
    }
}

export async function handleDelete(wrapEl, msg) {
    // Deleting mid-generation truncates the session under the streaming epilogue,
    // which then re-finds/re-writes messages by id — block it like handleEdit.
    if (state.generating) { toastr.info('Дождитесь завершения генерации.', EXT_DISPLAY); return; }
    const isUser = msg.role === 'user';
    const confirmed = await showCustomDialog({
        type: 'confirm',
        title: 'Удалить сообщение',
        message: isUser
            ? 'Удалить это сообщение и все последующие?'
            : 'Удалить это сообщение ассистента?',
    });
    if (!confirmed) return;
    const session = getCurrentSession();
    if (isUser) {
        truncateFrom(session, msg.id);
        removeMsgElAndBelow(msg.id);
    } else {
        deleteMsg(session, msg.id);
        removeMsgEl(msg.id);
    }
    updateMsgCount(session);
    if (!session.messages.length) renderSession(session);
}

// Окно ленивого рендера: длинные сессии рендерятся последними N сообщениями,
// старые подгружаются кнопкой. На payload это не влияет — только DOM.
const MSG_RENDER_WINDOW = 80;
