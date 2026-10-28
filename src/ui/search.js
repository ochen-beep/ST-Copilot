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

import { apiMod, uiWinMod, uiWdgMod, uiSetMod, featCharUiMod, _renderFromBySession } from './chat-shared.js';
import { renderSession } from './session-view.js';
export function openSearch() {
    _dbgAdd('SEARCH_TOGGLE', { state: 'open' });
    state.searchOpen = true;
    const bar = document.getElementById('scp-search-bar');
    if (bar) {
        bar.classList.add('scp-search-open');
        requestAnimationFrame(() => {
            const inp = document.getElementById('scp-search-input');
            if (inp) { inp.focus(); inp.select(); }
        });
    }
    document.getElementById('scp-search-btn')?.classList.add('active');
}

export function closeSearch() {
    _dbgAdd('SEARCH_TOGGLE', { state: 'close' });
    state.searchOpen = false;
    state.searchWholeWord = false;
    document.getElementById('scp-search-bar')?.classList.remove('scp-search-open');
    document.getElementById('scp-search-btn')?.classList.remove('active');
    document.getElementById('scp-search-word')?.classList.remove('active');
    clearSearchHighlights();
    state.searchMatches = [];
    state.searchIdx = -1;
    const inp = document.getElementById('scp-search-input');
    if (inp) inp.value = '';
    state.searchQuery = '';
    updateSearchCount();
}

export function clearSearchHighlights() {
    const marks = document.querySelectorAll('#scp-messages mark.scp-search-hl');
    if (!marks.length) return;
    const parents = new Set();
    marks.forEach(m => {
        const p = m.parentNode;
        if (!p) return;
        p.replaceChild(document.createTextNode(m.textContent), m);
        parents.add(p);
    });
    parents.forEach(p => p.normalize());
}

export function updateSearchCount() {
    const el = document.getElementById('scp-search-count');
    if (!el) return;
    el.textContent = (state.searchMatches.length && state.searchQuery)
        ? `${state.searchIdx + 1}/${state.searchMatches.length}`
        : '';
}

export function _applyHighlightsInRoot(root) {
    const lq = state.searchQuery.toLowerCase();
    let regex = null;
    if (state.searchWholeWord) {
        // \b не матчит кириллицу — границы слова через Unicode-классы.
        try { regex = new RegExp(`(?<![\\p{L}\\p{N}_])${lq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu'); } catch(_) {}
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('.scp-msg-actions,.scp-msg-meta,.scp-msg-avatar,.scp-reasoning-summary,.scp-search-hl,.scp-code-toolbar'))
                return NodeFilter.FILTER_REJECT;
            if (!p.closest('.scp-msg-body')) return NodeFilter.FILTER_REJECT;
            if (regex) {
                regex.lastIndex = 0;
                const hit = regex.test(node.nodeValue);
                regex.lastIndex = 0;
                return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
            return node.nodeValue.toLowerCase().includes(lq)
                ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    const newMarks = [];
    
    try {
        for (const node of textNodes) {
            const text = node.nodeValue;
            const frag = document.createDocumentFragment();
            let lastIndex = 0;

            if (regex) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(text)) !== null) {
                    if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    const mark = document.createElement('mark');
                    mark.className = 'scp-search-hl';
                    mark.textContent = match[0];
                    frag.appendChild(mark);
                    newMarks.push(mark);
                    lastIndex = match.index + match[0].length;
                }
            } else {
                const lower = text.toLowerCase();
                let idx = lower.indexOf(lq, 0);
                if (idx === -1) continue;
                while (idx !== -1) {
                    if (idx > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
                    const mark = document.createElement('mark');
                    mark.className = 'scp-search-hl';
                    mark.textContent = text.slice(idx, idx + state.searchQuery.length);
                    frag.appendChild(mark);
                    newMarks.push(mark);
                    lastIndex = idx + state.searchQuery.length;
                    idx = lower.indexOf(lq, lastIndex);
                }
            }

            if (lastIndex === 0) continue;
            if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            node.parentNode.replaceChild(frag, node);
        }
    } catch (e) {
        _dbgAdd('SEARCH_HIGHLIGHT_DOM_CORRUPTION', { error: e.message });
    }

    return newMarks;
}

export function performSearch() {
    clearSearchHighlights();
    state.searchMatches = [];
    state.searchIdx = -1;
    const q = state.searchQuery.trim();
    if (!q) { updateSearchCount(); return; }
    const container = document.getElementById('scp-messages');
    if (!container) return;
    state.searchMatches = _applyHighlightsInRoot(container);

    // Ленивое окно рендера прячет старые сообщения из DOM: совпадение там
    // раньше молча давало «нет результатов». Проверяем данные и при попадании
    // дорисовываем скрытую часть, потом подсвечиваем заново.
    if (!state.searchMatches.length) {
        const session = getCurrentSession();
        const from = _renderFromBySession.get(session.id) ?? 0;
        if (from > 0 && _sessionHeadHasMatch(session, from, q)) {
            _renderFromBySession.set(session.id, 0);
            renderSession(session, { keepScroll: true });
            state.searchMatches = _applyHighlightsInRoot(container);
        }
    }

    _dbgAdd('SEARCH_QUERY_EXECUTE', { query: state.searchQuery, wholeWord: state.searchWholeWord, matches: state.searchMatches.length });

    if (state.searchMatches.length) {
        state.searchIdx = 0;
        state.searchMatches[0].classList.add('scp-search-current');
        state.searchMatches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    updateSearchCount();
}

// Есть ли совпадение в скрытой (неотрисованной) части сессии: messages[0..from).
// Условия совпадения те же, что у подсветки: подстрока без учёта регистра
// или whole-word с Unicode-границами (см. _applyHighlightsInRoot).
function _sessionHeadHasMatch(session, from, q) {
    const lq = q.toLowerCase();
    let regex = null;
    if (state.searchWholeWord) {
        try { regex = new RegExp(`(?<![\\p{L}\\p{N}_])${lq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu'); } catch(_) {}
    }
    const texts = m => [m.content, m.reasoning, ...(m.swipes || []).map(s => s?.content)].filter(t => typeof t === 'string');
    for (let i = 0; i < Math.min(from, session.messages.length); i++) {
        for (const t of texts(session.messages[i])) {
            if (regex) { regex.lastIndex = 0; if (regex.test(t)) return true; }
            else if (t.toLowerCase().includes(lq)) return true;
        }
    }
    return false;
}

export function navigateSearch(dir) {
    if (!state.searchMatches.length) return;
    state.searchMatches[state.searchIdx]?.classList.remove('scp-search-current');
    state.searchIdx = (state.searchIdx + dir + state.searchMatches.length) % state.searchMatches.length;
    const cur = state.searchMatches[state.searchIdx];
    cur.classList.add('scp-search-current');
    cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateSearchCount();
}

// ─── Chat Picker ───────────────────────────────────────────────

export function toggleSearchWholeWord() {
    state.searchWholeWord = !state.searchWholeWord;
    document.getElementById('scp-search-word')?.classList.toggle('active', state.searchWholeWord);
    if (state.searchQuery.trim()) performSearch();
}


let _searchHotkeyHandler = null;

export function setupSearchHotkey() {
    if (_searchHotkeyHandler) document.removeEventListener('keydown', _searchHotkeyHandler, true);
    _searchHotkeyHandler = null;
    const s = getSettings();
    if (!s.enabled || !s.searchHotkeyEnabled || !s.searchHotkey) return;

    const parts = s.searchHotkey.toLowerCase().split('+').map(p => p.trim());
    const key = parts[parts.length - 1];
    const needAlt = parts.includes('alt');
    const needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needShift = parts.includes('shift');
    const needMeta = parts.includes('meta') || parts.includes('cmd');

    _searchHotkeyHandler = e => {
        if (e.key.toLowerCase() !== key) return;
        if (needAlt !== e.altKey || needCtrl !== e.ctrlKey || needShift !== e.shiftKey || needMeta !== e.metaKey) return;
        
        if (!state.copilotActive) return;
        
        const win = document.getElementById('scp-window');
        if (!win || win.style.display === 'none') return;
        
        const overlays = ['scp-lb-overlay', 'scp-settings-overlay', 'scp-picker-overlay', 'scp-diff-modal', 'scp-changelog-modal'];
        for (const id of overlays) {
            const el = document.getElementById(id);
            if (el && el.style.display !== 'none' && el.style.display !== '') return;
        }
        if (document.querySelector('.scp-dialog-overlay.visible')) return;
        
        e.preventDefault();
        e.stopPropagation();
        if (state.searchOpen) { document.getElementById('scp-search-input')?.focus(); }
        else openSearch();
    };
    document.addEventListener('keydown', _searchHotkeyHandler, true);
}