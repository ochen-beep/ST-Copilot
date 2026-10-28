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
import { updateMsgCount, renderSession } from './session-view.js';
export function getPickedChatIndices() {
    try { return getCurrentSession().pickedChatIndices || []; } catch(_) { return []; }
}

export function setPickedChatIndices(indices) {
    try {
        const sess = getCurrentSession();
        sess.pickedChatIndices = [...indices].sort((a, b) => a - b);
        saveSessionsToMetadata();
        updatePickBtnState();
        updateMsgCount(sess);
    } catch(_) {}
}

export function updatePickBtnState() {
    const picked = getPickedChatIndices();
    const btn = document.getElementById('scp-pick-btn');
    const badge = document.getElementById('scp-pick-badge');
    const isActive = picked.length > 0;
    btn?.classList.toggle('active', isActive);
    if (badge) { badge.style.display = isActive ? '' : 'none'; badge.textContent = picked.length; }
    const depthSlider = document.getElementById('scp-depth-slider');
    const depthVal = document.getElementById('scp-depth-val');
    depthSlider?.classList.toggle('scp-slider-overridden', isActive);
    depthVal?.classList.toggle('scp-depth-val-overridden', isActive);
}

let _pickerLastIdx = -1;

export function openChatPicker() {
    const overlay = document.getElementById('scp-picker-overlay');
    if (!overlay) return;
    _dbgAdd('PICKER_OPEN');
    if (uiWinMod) uiWinMod.applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    _pickerLastIdx = -1;
    renderPickerMessages();
    overlay.style.display = 'flex';
    if (uiWinMod) uiWinMod.bringWindowToFront();
}

export function closeChatPicker() {
    _dbgAdd('PICKER_CLOSE');
    const overlay = document.getElementById('scp-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

export function renderPickerMessages() {
    const body = document.getElementById('scp-picker-body');
    if (!body) return;
    const ctx = SillyTavern.getContext();
    const msgs = ctx.chat || [];
    const pickedSet = new Set(getPickedChatIndices());
    const charInfo = getCharInfo();

    body.innerHTML = '';
    if (!msgs.length) {
        body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--scp-text-muted)">В текущем чате нет сообщений</div>';
        _updatePickerCountEl(0);
        return;
    }

    const frag = document.createDocumentFragment();
    msgs.forEach((msg, idx) => {
        const isUser = msg.is_user;
        const name = isUser ? (ctx.name1 || 'User') : (msg.name || charInfo?.name || 'Character');
        const isSelected = pickedSet.has(idx);
        const row = document.createElement('div');
        row.className = `scp-picker-row${isSelected ? ' selected' : ''}${isUser ? ' user' : ''}`;
        row.dataset.idx = idx;

        const cb = document.createElement('div');
        cb.className = `scp-picker-cb${isSelected ? ' checked' : ''}`;

        const meta = document.createElement('div');
        meta.className = 'scp-picker-meta';

        const idxEl = document.createElement('span');
        idxEl.className = 'scp-picker-idx';
        idxEl.textContent = `#${idx}`;

        const nameEl = document.createElement('span');
        nameEl.className = 'scp-picker-name';
        nameEl.textContent = name;

        meta.appendChild(idxEl);
        meta.appendChild(nameEl);

        const textEl = document.createElement('div');
        textEl.className = 'scp-picker-text';
        const raw = (msg.mes || '').replace(/<[^>]+>/g, '').trim();
        const s2 = getSettings();
        const firstLines = Math.max(1, parseInt(s2.pickerPreviewLines) || 1);
        const lastLines = Math.max(0, parseInt(s2.pickerPreviewLastLines) || 0);
        let preview = '';
        if (lastLines > 0) {
            const allLines = raw.split('\n');
            const head = allLines.slice(0, firstLines).join('\n');
            const tail = allLines.length > firstLines
                ? allLines.slice(-lastLines).join('\n')
                : '';
            preview = tail && tail !== head ? head + '\n…\n' + tail : head;
        } else {
            preview = raw.split('\n').slice(0, firstLines).join('\n');
            if (preview.length < raw.length) preview += ' …';
        }
        textEl.textContent = preview;

        const infoCol = document.createElement('div');
        infoCol.className = 'scp-picker-info-col';
        infoCol.appendChild(meta);
        infoCol.appendChild(textEl);

        row.appendChild(cb);
        row.appendChild(infoCol);

        row.addEventListener('click', e => {
            const curIdx = parseInt(row.dataset.idx);
            const curMsg = msgs[curIdx];

            if (e.ctrlKey || e.metaKey) {
                _dbgAdd('PICKER_SHORTCUT_TRIGGERED', { type: 'ctrl' });
                const targetState = !row.classList.contains('selected');
                body.querySelectorAll('.scp-picker-row').forEach(r => {
                    const ri = parseInt(r.dataset.idx);
                    const rm = msgs[ri];
                    if (rm && rm.is_user === curMsg.is_user && rm.name === curMsg.name) {
                        r.classList.toggle('selected', targetState);
                        r.querySelector('.scp-picker-cb')?.classList.toggle('checked', targetState);
                    }
                });
            } else if (e.altKey) {
                 _dbgAdd('PICKER_SHORTCUT_TRIGGERED', { type: 'alt' });
                const targetState = !row.classList.contains('selected');
                body.querySelectorAll('.scp-picker-row').forEach(r => {
                    const ri = parseInt(r.dataset.idx);
                    const rm = msgs[ri];
                    if (rm && !(rm.is_user === curMsg.is_user && rm.name === curMsg.name)) {
                        r.classList.toggle('selected', targetState);
                        r.querySelector('.scp-picker-cb')?.classList.toggle('checked', targetState);
                    }
                });
            } else if (e.shiftKey && _pickerLastIdx >= 0) {
                _dbgAdd('PICKER_SHORTCUT_TRIGGERED', { type: 'shift' });
                const lo = Math.min(_pickerLastIdx, curIdx);
                const hi = Math.max(_pickerLastIdx, curIdx);
                const targetState = !row.classList.contains('selected');
                body.querySelectorAll('.scp-picker-row').forEach(r => {
                    const ri = parseInt(r.dataset.idx);
                    if (ri >= lo && ri <= hi) {
                        r.classList.toggle('selected', targetState);
                        r.querySelector('.scp-picker-cb')?.classList.toggle('checked', targetState);
                    }
                });
            } else {
                const sel = row.classList.toggle('selected');
                _dbgAdd('PICKER_TOGGLE_SINGLE', { idx: curIdx, state: sel });
                cb.classList.toggle('checked', sel);
                _pickerLastIdx = curIdx;
            }
            _updatePickerCountEl();
        });

        frag.appendChild(row);
    });
    body.appendChild(frag);
    _updatePickerCountEl(pickedSet.size);
    const firstSel = body.querySelector('.scp-picker-row.selected');
    if (firstSel) setTimeout(() => firstSel.scrollIntoView({ block: 'center' }), 50);
}

export function _updatePickerCountEl(count) {
    const el = document.getElementById('scp-picker-count');
    if (!el) return;
    const n = count !== undefined ? count : document.querySelectorAll('#scp-picker-body .scp-picker-row.selected').length;
    el.textContent = `${n} выбрано`;
}

export function setupChatPickerListeners() {
    const overlay = document.getElementById('scp-picker-overlay');
    if (!overlay) return;

    let _mouseDownTarget = null;
    overlay.addEventListener('mousedown', e => { _mouseDownTarget = e.target; });
    overlay.addEventListener('click', e => { if (e.target === overlay && _mouseDownTarget === overlay) closeChatPicker(); });

    document.getElementById('scp-picker-close')?.addEventListener('click', closeChatPicker);

    document.getElementById('scp-picker-all')?.addEventListener('click', () => {
        document.querySelectorAll('#scp-picker-body .scp-picker-row').forEach(r => {
            r.classList.add('selected');
            r.querySelector('.scp-picker-cb')?.classList.add('checked');
        });
        _updatePickerCountEl();
    });

    document.getElementById('scp-picker-invert')?.addEventListener('click', () => {
        document.querySelectorAll('#scp-picker-body .scp-picker-row').forEach(r => {
            const s = r.classList.toggle('selected');
            r.querySelector('.scp-picker-cb')?.classList.toggle('checked', s);
        });
        _updatePickerCountEl();
    });

    document.getElementById('scp-picker-clear')?.addEventListener('click', () => {
        document.querySelectorAll('#scp-picker-body .scp-picker-row').forEach(r => {
            r.classList.remove('selected');
            r.querySelector('.scp-picker-cb')?.classList.remove('checked');
        });
        _updatePickerCountEl();
    });

    document.getElementById('scp-picker-apply')?.addEventListener('click', () => {
        const rows = document.querySelectorAll('#scp-picker-body .scp-picker-row');
        const indices = [];
        rows.forEach(r => { if (r.classList.contains('selected')) indices.push(parseInt(r.dataset.idx)); });
        _dbgAdd('PICKER_APPLY', { count: indices.length });
        setPickedChatIndices(indices);
        closeChatPicker();
    });
}

// ─── Generation state ─────────────────────────────────────────────────────

