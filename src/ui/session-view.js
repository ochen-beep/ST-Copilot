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

import { apiMod, uiWinMod, uiWdgMod, uiSetMod, featCharUiMod, _renderFromBySession, MSG_RENDER_WINDOW } from './chat-shared.js';
import { _renderMsgBodyContent, _updateMsgTokenCount } from './render-msg.js';
import { getSwipesForMsg, navigateSwipe, updateSwipeBar, _runSwipeRegen, _refreshSwipeBars, _refreshContinueBtns, scrollToBottom, handleCopy, handleEdit, handleMessageRegen, handleDelete } from './msg-actions.js';
import { clearSearchHighlights, updateSearchCount, performSearch } from './search.js';
import { closeChatPicker, updatePickBtnState } from './chat-picker.js';
export function renderSession(session, opts = {}) {
    clearSearchHighlights();
    state.searchMatches = [];
    state.searchIdx = -1;
    updateSearchCount();
    const c = document.getElementById('scp-messages');
    if (!c) return;
    // keepScroll: рендер растёт только сверху (подгрузка старых сообщений или
    // расширение окна под поиск) — держим видимую позицию, а не прыгаем вниз.
    const anchor = opts.keepScroll ? { h: c.scrollHeight, top: c.scrollTop } : null;
    c.innerHTML = '';
    if (!session.messages.length) {
        c.innerHTML = `
            <div class="scp-empty-state">
                <div class="scp-empty-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7" /><ellipse cx="12" cy="12" rx="11" ry="3" transform="rotate(-25 12 12)" /><circle cx="21.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" /></svg>
                </div>
                <div class="scp-empty-title">Новая сессия</div>
                <div class="scp-empty-sub">Задавайте любые вопросы о вашем ролеплее — проверка континуальности, анализ персонажей, обратная связь по тексту, проработка мира и многое другое.</div>
            </div>`;
        updateMsgCount(session);
        return;
    }

    const total = session.messages.length;
    const from = computeRenderFrom(total, _renderFromBySession.get(session.id), MSG_RENDER_WINDOW);
    _renderFromBySession.set(session.id, from);

    if (from > 0) {
        const loadOlder = document.createElement('button');
        loadOlder.className = 'scp-load-older-btn';
        const hiddenCount = from;
        loadOlder.textContent = `⬆ Показать ещё ${Math.min(MSG_RENDER_WINDOW, hiddenCount)} из ${hiddenCount} скрытых`;
        loadOlder.title = 'Старые сообщения не отрисованы для производительности (на контекст ИИ это не влияет)';
        loadOlder.addEventListener('click', () => {
            const prev = _renderFromBySession.get(session.id) ?? 0;
            _renderFromBySession.set(session.id, Math.max(0, prev - MSG_RENDER_WINDOW));
            renderSession(session, { keepScroll: true });
            // renderSession resets search state and wiped the highlights; with a
            // search open, re-run it so the expanded render stays highlighted.
            if (state.searchQuery.trim()) performSearch();
        });
        c.appendChild(loadOlder);
    }

    for (let i = from; i < total; i++) {
        const msg = session.messages[i];
        if (msg.isLBHistory || msg.isCharEditHistory || msg.isChatEditHistory) {
            appendLBHistoryEl(msg);
        } else {
            const el = createMsgEl(msg, handleCopy, handleEdit, handleDelete, handleMessageRegen);
            c.appendChild(el);
        }
    }
    updateMsgCount(session);
    _refreshContinueBtns();
    _refreshSwipeBars(session);
    if (anchor) {
        // Контент дорисовался сверху — сдвигаем scrollTop на высоту добавленного,
        // чтобы читаемое сообщение осталось на месте.
        requestAnimationFrame(() => { c.scrollTop = anchor.top + (c.scrollHeight - anchor.h); });
    } else {
        requestAnimationFrame(() => scrollToBottom());
    }
}

export function appendMsgEl(msg, isStreamInit = false) {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    c.querySelector('.scp-empty-state')?.remove();

    const el = createMsgEl(msg, handleCopy, handleEdit, handleDelete, handleMessageRegen);
    c.appendChild(el);
    
    if (!isStreamInit) {
        const session = getCurrentSession();
        updateMsgCount(session);
        _refreshContinueBtns();
        _refreshSwipeBars(session);
        requestAnimationFrame(() => scrollToBottom());

        if (state.searchOpen && state.searchQuery.trim()) {
            const newMarks = _applyHighlightsInRoot(el);
            if (newMarks.length) {
                state.searchMatches.push(...newMarks);
                updateSearchCount();
            }
        }
    }
}

export function removeMsgEl(msgId) {
    const el = document.querySelector(`.scp-msg[data-id="${msgId}"]`);
    if (!el) return;
    document.querySelector(`.scp-lb-proposal-card[data-for="${msgId}"]`)?.remove();
    document.querySelectorAll(`.scp-char-proposal-card[data-for="${msgId}"]`).forEach(c => c.remove());
    document.querySelector(`.scp-char-creation-card[data-for="${msgId}"]`)?.remove();
    document.querySelector(`.scp-chat-proposal-card[data-for="${msgId}"]`)?.remove();
    el.remove();
    _refreshContinueBtns();
    _refreshSwipeBars(getCurrentSession());
}

export function removeMsgElAndBelow(msgId) {
    const c = document.getElementById('scp-messages'); if (!c) return;
    let found = false;
    for (const el of [...c.querySelectorAll('.scp-msg')]) {
        if (el.dataset.id === msgId) found = true;
        if (found) {
            document.querySelector(`.scp-lb-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelectorAll(`.scp-char-proposal-card[data-for="${el.dataset.id}"]`).forEach(c => c.remove());
            document.querySelector(`.scp-char-creation-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-chat-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            el.remove();
        }
    }
    c.querySelectorAll('.scp-lb-proposal-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    c.querySelectorAll('.scp-char-proposal-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    c.querySelectorAll('.scp-char-creation-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    c.querySelectorAll('.scp-chat-proposal-card').forEach(card => { if (!card.previousElementSibling) card.remove(); });
    _refreshContinueBtns();
    _refreshSwipeBars(getCurrentSession());
}

export function removeMsgElAfter(msgId) {
    const c = document.getElementById('scp-messages'); if (!c) return;
    let found = false;
    for (const el of [...c.querySelectorAll('.scp-msg')]) {
        if (found) {
            document.querySelector(`.scp-lb-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelectorAll(`.scp-char-proposal-card[data-for="${el.dataset.id}"]`).forEach(card => card.remove());
            document.querySelector(`.scp-char-creation-card[data-for="${el.dataset.id}"]`)?.remove();
            document.querySelector(`.scp-chat-proposal-card[data-for="${el.dataset.id}"]`)?.remove();
            el.remove();
        }
        if (el.dataset.id === msgId) found = true;
    }
    _refreshContinueBtns();
    _refreshSwipeBars(getCurrentSession());
}

let _tokenCalcTid = null;
let _isTokenCalculating = false;
let _pendingTokenCalc = false;

export function updateMsgCount(session) {
    const el = document.getElementById('scp-msg-count');
    if (el && session) el.textContent = `${session.messages.length} msgs`;

    const tel = document.getElementById('scp-token-count');
    if (!tel || !session) return;

    // Дебаунс 600ms — меньше CPU при наборе текста без визуальной потери
    // (пользователь не смотрит на цифру непрерывно во время печати).
    clearTimeout(_tokenCalcTid);
    _tokenCalcTid = setTimeout(() => {
        if (_isTokenCalculating) { _pendingTokenCalc = true; return; }

        const runCalc = async () => {
            _isTokenCalculating = true;
            try {
                // Используем быстрое приближение (chars / 3.5) для实时-обновления
                // индикатора токенов рядом с полем ввода. Точный подсчёт через
                // assembleMessages + estimateTokens выполняется один раз при отправке
                // в runGenerate / runContinue / _runSwipeRegen.
                //
                // Раньше тут был полноценный вызов assembleMessages (O(N×M): сообщения
                // × активные лорбуки) плюс fallback на ту же формулу — теперь только
                // быстрая оценка, дающая тот же результат, что и прежний fallback.
                const settings = getEffectiveSettings();
                const currentInput = document.getElementById('scp-input')?.value || '';

                const ctx = SillyTavern.getContext();
                const incHidden = !!settings.includeHiddenMessages;

                let totalChars = (settings.systemPrompt || '').length;

                const depth = Math.max(0, parseInt(settings.contextDepth) || 0);
                const chat = ctx.chat || [];
                let chatSlice = [];
                try {
                    const sess = getCurrentSession();
                    const picked = sess?.pickedChatIndices;
                    if (picked && picked.length > 0) {
                        chatSlice = picked.filter(i => i >= 0 && i < chat.length).map(i => chat[i]);
                    } else if (depth > 0) {
                        chatSlice = chat.slice(-depth);
                    }
                } catch(_) {
                    if (depth > 0) chatSlice = chat.slice(-depth);
                }

                for (const m of chatSlice) {
                    if (!incHidden && (m.is_system || m.is_hidden || m.extra?.is_hidden || m.extra?.sc_ghosted)) continue;
                    totalChars += (m.mes || '').length;
                }

                const limit = Math.max(1, parseInt(settings.localHistoryLimit) || 50);
                for (const m of session.messages.slice(-limit)) {
                    totalChars += (m.content || '').length;
                }

                totalChars += currentInput.length;
                const count = Math.ceil(totalChars / 3.5);
                const node = document.getElementById('scp-token-count');
                if (node) node.textContent = `~${count} tkns`;
            } finally {
                _isTokenCalculating = false;
                if (_pendingTokenCalc) { _pendingTokenCalc = false; runCalc(); }
            }
        };
        runCalc();
    }, 600);
}

export function updateDepthSlidersMax() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || window.chat ||[];
    const maxVal = Math.max(1, chat.length);
    
    if (state.lastChatLen === -1) {
        state.lastChatLen = maxVal;
    }

    const s = getSettings();
    const sess = getCurrentSession();
    let settingsChanged = false;

    const globalDepth = parseInt(s.contextDepth) || 0;
    if (globalDepth >= state.lastChatLen && maxVal > state.lastChatLen) {
        s.contextDepth = maxVal;
        settingsChanged = true;
    }

    if (sess && sess.overrides && sess.overrides.contextDepth !== undefined) {
        const ovDepth = parseInt(sess.overrides.contextDepth) || 0;
        if (ovDepth >= state.lastChatLen && maxVal > state.lastChatLen) {
            sess.overrides.contextDepth = maxVal;
            settingsChanged = true;
        }
    }

    if (settingsChanged) {
        saveSettings();
    }

    state.lastChatLen = maxVal;
    const eff = getEffectiveSettings();

    const sliders =[
        { id: 'scp-depth-slider', valId: 'scp-depth-val', setting: s.contextDepth },
        { id: 'scp-sp-depth-slider', valId: 'scp-sp-depth-val', setting: s.contextDepth },
        { id: 'scp-sp-ov-depth-slider', valId: 'scp-sp-ov-depth-val', setting: eff.contextDepth }
    ];

    sliders.forEach(item => {
        const el = document.getElementById(item.id);
        if (el) {
            if (parseInt(el.max) !== maxVal) el.max = maxVal;
            const renderVal = Math.min(maxVal, parseInt(item.setting ?? 15));
            el.value = renderVal;
            const valEl = document.getElementById(item.valId);
            if (valEl) valEl.textContent = renderVal;
        }
    });
}

// ─── Chat search ───────────────────────────────────────────────────────────

export function setGeneratingState(on) {
    const bar = document.getElementById('scp-thinking-bar'), sendBtn = document.getElementById('scp-send-btn'),
          input = document.getElementById('scp-input'), regenBtn = document.getElementById('scp-regen-btn');
    if (bar) {
        bar.style.display = on ? 'flex' : 'none';
        if (on) {
            const t = document.getElementById('scp-thinking-text');
            if (t) t.textContent = 'Думаю…';
        }
    }
    if (sendBtn) sendBtn.disabled = on;
    if (input) input.disabled = on;
    if (regenBtn) regenBtn.disabled = on;
    if (!on) {
        _refreshContinueBtns();
        _refreshSwipeBars(getCurrentSession());
    }
    // v2.10.0: pulse the launcher button during generation.
    import('../ui/ui-launcher.js').then(m => m.refreshLauncher()).catch(() => {});
}

export function showGenerationError(err) {
    let errorSummary = err?.message || String(err);
    let fullError = '';

    if (err instanceof Error) {
        fullError = err.stack || err.message;
        if (err.cause) {
            fullError += '\n\n--- CAUSE ---\n' + (err.cause.stack || err.cause.message || JSON.stringify(err.cause, null, 2));
        }
    } else if (typeof err === 'object') {
        try {
            errorSummary = "Ошибка API или сети";
            fullError = JSON.stringify(err, null, 2);
        } catch(e) {
            fullError = String(err);
        }
    } else {
        fullError = String(err);
    }

    if (window.last_api_error && errorSummary.includes('userStopped') === false) {
        fullError += '\n\n--- ST LAST API ERROR ---\n' + (typeof window.last_api_error === 'object' ? JSON.stringify(window.last_api_error, null, 2) : String(window.last_api_error));
    }

    showCustomDialog({
        type: 'alert',
        title: 'Ошибка генерации',
        htmlMessage: `
            <div style="color:var(--scp-danger); margin-bottom: 10px; font-weight: 600; font-size: 14px; word-break: break-word; line-height: 1.4;">
                ${escHtml(errorSummary)}
            </div>
            <div style="font-size: 12px; margin-bottom: 8px; color: var(--scp-text-muted);">
                Пожалуйста, скопируйте технические подробности ниже и скачайте отладочный лог (из настроек), чтобы сообщить о проблеме:
            </div>
            <textarea style="width:100%; height:160px; background:rgba(0,0,0,0.4); color:var(--scp-text-muted); border:1px solid rgba(255,255,255,0.15); padding:8px; border-radius:6px; font-family:var(--scp-font-mono, monospace); resize:vertical; font-size:11px; white-space:pre; word-wrap:normal; overflow-x:auto;" readonly onclick="this.select()">${escHtml(fullError)}</textarea>
        `
    });
}

// ─── Chat Events (SillyTavern) ──────────────────────────────────────────────

export async function onChatChanged() {
    if (state.generating) {
        state.abortController?.abort();
        // The abort alone does not stop tool rounds: the round loop checks
        // generationStopped, not the (already nulled) controller. Without this
        // flag a zombie generation keeps issuing paid API rounds for the old chat.
        state.generationStopped = true;
        state.generating = false;
        setGeneratingState(false);
    }
    state.lastChatLen = -1;
    
    // clean cache
    if (uiWdgMod) uiWdgMod.closeFavoritesPanel();
    // A picker left open after a chat switch shows rows of the old chat; Apply
    // would persist those indices into the new chat's session context.
    closeChatPicker();
    
    const badge = document.getElementById('scp-char-badge');
    if (badge) {
        const ctx = SillyTavern.getContext(); const char = ctx.characters?.[ctx.characterId];
        if (char) { badge.textContent = char.name; badge.style.display = ''; }
        else { badge.style.display = 'none'; }
    }
    
    await initChatBucket();
    
    if (uiSetMod) {
        uiSetMod.autoLoadBoundProfile();
        uiSetMod.updateSessionOverrideIndicator();
    }
    if (featCharUiMod) {
        featCharUiMod.refreshAltGreetingsPickers();
    }
    if (uiWdgMod) {
        uiWdgMod.renderQuickPromptsBar();
    }
    
    updateDepthSlidersMax();
    updatePickBtnState();
}

export function setupDepthClickEdit() {
    const valEl = document.getElementById('scp-depth-val'); if (!valEl) return;
    
    const newEl = valEl.cloneNode(true);
    valEl.replaceWith(newEl);
    
    newEl.addEventListener('click', () => {
        const cur = getSettings().contextDepth;
        const input = document.createElement('input');
        input.type = 'number'; input.className = 'scp-depth-input';
        input.value = cur; input.min = 0;
        
        newEl.replaceWith(input); 
        input.focus(); input.select();
        
        let isCommitted = false;
        const commit = () => {
            if (isCommitted || !input.parentNode) return;
            isCommitted = true;

            const val = Math.max(0, parseInt(input.value) || 0);
            getSettings().contextDepth = val; saveSettings();
            
            updateDepthSlidersMax();
            import('./ui-settings.js').then(m => m.syncOverlayUI('contextDepth', val));
            
            const span = document.createElement('span');
            span.className = 'scp-depth-val scp-depth-clickable'; span.id = 'scp-depth-val';
            span.title = 'Нажмите, чтобы ввести точное значение'; span.textContent = val;
            
            input.parentNode.replaceChild(span, input);
            setupDepthClickEdit();
            
            const slider = document.getElementById('scp-depth-slider');
            if (slider) { slider.value = val; }
            updateMsgCount(getCurrentSession());
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => { 
            if (e.key === 'Enter') { e.preventDefault(); commit(); } 
            if (e.key === 'Escape') { e.preventDefault(); commit(); } 
        });
    });
}

// ─── Message element ─────────────────────────────────────────────────────────

export function createMsgEl(msg, onCopy, onEdit, onDelete, onRegen) {
    const isUser = msg.role === 'user';
    const wrap = document.createElement('div');
    wrap.className = `scp-msg ${isUser ? 'scp-msg-user' : 'scp-msg-assistant'}`;
    wrap.dataset.id = msg.id;

    const header = document.createElement('div');
    header.className = 'scp-msg-header';

    const avatar = document.createElement('div');
    avatar.className = 'scp-msg-avatar';
    avatar.innerHTML = isUser ? I.user : I.bot;

    const meta = document.createElement('div');
    meta.className = 'scp-msg-meta';
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = msg.genStamp ? `${timeStr} · ${msg.genStamp}` : timeStr;
    if (msg.genStamp) meta.title = msg.genStamp;

    const tokenCountEl = document.createElement('div');
    tokenCountEl.className = 'scp-msg-token-count';
    tokenCountEl.textContent = '…';
    _updateMsgTokenCount({ querySelector: () => tokenCountEl, isConnected: true }, msg.content);

    const headerRight = document.createElement('div');
    headerRight.className = 'scp-msg-header-right';
    headerRight.appendChild(meta);
    headerRight.appendChild(tokenCountEl);

    header.appendChild(avatar);
    header.appendChild(headerRight);

    const body = document.createElement('div');
    body.className = 'scp-msg-body';

    const content = document.createElement('div');
    content.className = 'scp-msg-content';
    body.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'scp-msg-actions';

    const makeBtn = (icon, label, cls, cb) => {
        const b = document.createElement('button');
        b.className = `scp-msg-btn${cls ? ' ' + cls : ''}`;
        b.innerHTML = icon; b.title = label;
        b.addEventListener('click', cb);
        return b;
    };

    actions.appendChild(makeBtn(I.copy, 'Копировать', '', () => onCopy(msg)));
    actions.appendChild(makeBtn(I.edit, 'Изменить', '', () => onEdit(wrap, msg)));
    actions.appendChild(makeBtn(I.refresh, 'Перегенерировать', '', () => onRegen(wrap, msg)));
    actions.appendChild(makeBtn(I.trash, 'Удалить', 'scp-msg-btn-danger', () => onDelete(wrap, msg)));

    const isStarred = isMessageStarred(msg.id);
    const starBtn = makeBtn(isStarred ? I.starFill : I.star, isStarred ? 'Убрать из избранного' : 'В избранное', `scp-msg-btn-star${isStarred ? ' starred' : ''}`, () => {
        const nowStarred = toggleStarMessage(msg.id);
        starBtn.innerHTML = nowStarred ? I.starFill : I.star;
        starBtn.title = nowStarred ? 'Убрать из избранного' : 'В избранное';
        starBtn.classList.toggle('starred', nowStarred);
        wrap.classList.toggle('scp-msg-starred', nowStarred);
        if (document.getElementById('scp-fav-panel')?.style.display !== 'none' && uiWdgMod) {
            uiWdgMod.renderFavoritesPanel();
        }
    });
    actions.appendChild(starBtn);
    if (isStarred) wrap.classList.add('scp-msg-starred');

    if (!isUser) {
        const continueBtn = makeBtn(I.continueArrow, 'Продолжить ответ', 'scp-msg-btn-continue', () => {
            if (apiMod) apiMod.runContinue(getCurrentSession(), msg.id);
        });
        actions.appendChild(continueBtn);
    }

    body.appendChild(actions);

    if (!isUser) {
        const swipeBar = document.createElement('div');
        swipeBar.className = 'scp-swipe-bar';
        swipeBar.style.display = 'none';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'scp-swipe-btn scp-swipe-prev';
        prevBtn.innerHTML = I.chevronLeft;
        prevBtn.title = 'Предыдущий вариант';
        prevBtn.disabled = true;

        const counter = document.createElement('span');
        counter.className = 'scp-swipe-counter';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'scp-swipe-btn scp-swipe-next';
        nextBtn.innerHTML = I.chevronRight;
        nextBtn.title = 'Новый вариант (перегенерировать)';

        prevBtn.addEventListener('click', async () => {
            if (prevBtn.disabled || state.generating) return;
            if (wrap.classList.contains('is-editing')) { toastr.info('Сначала завершите редактирование сообщения.', EXT_DISPLAY); return; }
            const session = getCurrentSession();
            if (!getSwipesForMsg(session, msg.id)) return;
            
            const bdy = wrap.querySelector('.scp-msg-body');
            if (bdy) {
                bdy.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
                bdy.classList.add('scp-swipe-anim-out-right'); 
                await new Promise(r => setTimeout(r, 150));
            }
            
            if (navigateSwipe(session, msg.id, -1)) {
                if (bdy) {
                    bdy.classList.remove('scp-swipe-anim-out-right');
                    void bdy.offsetWidth;
                    bdy.classList.add('scp-swipe-anim-left'); 
                }
                _renderMsgBodyContent(wrap, session.messages.find(m => m.id === msg.id));
                updateSwipeBar(wrap, session, msg.id);
            }
        });

        nextBtn.addEventListener('click', async () => {
            if (nextBtn.disabled || state.generating) return;
            if (wrap.classList.contains('is-editing')) { toastr.info('Сначала завершите редактирование сообщения.', EXT_DISPLAY); return; }
            const session = getCurrentSession();
            const msgData = session.messages.find(m => m.id === msg.id);
            if (!msgData) return;
            
            if (msgData.swipeIndex !== undefined && msgData.swipeIndex < (msgData.swipes?.length || 1) - 1) {
                const bdy = wrap.querySelector('.scp-msg-body');
                if (bdy) {
                    bdy.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
                    bdy.classList.add('scp-swipe-anim-out-left'); 
                    await new Promise(r => setTimeout(r, 150));
                }

                if (navigateSwipe(session, msg.id, 1)) {
                    if (bdy) {
                        bdy.classList.remove('scp-swipe-anim-out-left');
                        void bdy.offsetWidth;
                        bdy.classList.add('scp-swipe-anim-right'); 
                    }
                    _renderMsgBodyContent(wrap, session.messages.find(m => m.id === msg.id));
                    updateSwipeBar(wrap, session, msg.id);
                }
            } else {
                _dbgAdd('SWIPE_REGEN_TRIGGERED', { msgId: msg.id });
                _runSwipeRegen(session, msg.id, wrap);
            }
        });

        swipeBar.appendChild(prevBtn);
        swipeBar.appendChild(counter);
        swipeBar.appendChild(nextBtn);

        const delSwipeBtn = document.createElement('button');
        delSwipeBtn.className = 'scp-swipe-btn scp-swipe-del';
        delSwipeBtn.innerHTML = I.x;
        delSwipeBtn.title = 'Удалить текущий вариант ответа';
        delSwipeBtn.addEventListener('click', async () => {
            if (state.generating) return;
            if (wrap.classList.contains('is-editing')) { toastr.info('Сначала завершите редактирование сообщения.', EXT_DISPLAY); return; }
            const session = getCurrentSession();
            const msgData = session.messages.find(m => m.id === msg.id);
            if (!msgData || (msgData.swipes?.length || 1) < 2) return;
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Удалить вариант',
                message: 'Удалить текущий вариант ответа? Остальные варианты сохранятся.'
            });
            if (!ok) return;
            msgData.swipes.splice(msgData.swipeIndex ?? 0, 1);
            msgData.swipeIndex = Math.min(msgData.swipeIndex ?? 0, msgData.swipes.length - 1);
            msgData.content = msgData.swipes[msgData.swipeIndex].content;
            msgData.reasoning = msgData.swipes[msgData.swipeIndex].reasoning || null;
            saveSessionsToMetadata();
            updateMsgCount(session);
            _renderMsgBodyContent(wrap, msgData);
            updateSwipeBar(wrap, session, msg.id);
        });
        swipeBar.appendChild(delSwipeBtn);
        body.appendChild(swipeBar);
    }

    wrap.appendChild(header); wrap.appendChild(body);
    _renderMsgBodyContent(wrap, msg);
    
    return wrap;
}
