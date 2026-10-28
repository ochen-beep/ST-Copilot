// Widgets: the context inspector modal (highlighted prompt preview, block
// search, JSON/raw views). Split out of ui-widgets.js (now a re-export
// facade); the exported mutable _lastInspectorMessages binding lives here.
import { state } from '../state.js';
import { getCurrentSession } from '../session.js';
import { escHtml } from '../utils/util-dom.js';
import { _processAttachmentsBeforeSend } from '../features/feature-attachments.js';
// Import from prompt-builder directly: api.js statically imports ui-widgets.js
// (playCompletionSound), and this module sits under the ui-widgets facade —
// that cycle materialized as undefined bindings under vite SSR.
import { assembleMessages } from '../api/prompt-builder.js';
// ─── Context Inspector ──────────────────────────────────────────────────────

// Поиск по блокам инспектора: без текстовой хирургии по подсвеченному HTML —
// матчим textContent блоков, подсвечиваем блок целиком, Enter/Shift+Enter листают.
let _ctxSearchBound = false;
let _ctxSearchMatches = [];
let _ctxSearchIdx = -1;

function _ctxSearchApply(query) {
    const body = document.getElementById('scp-ctx-body');
    const countEl = document.getElementById('scp-ctx-search-count');
    if (!body) return;
    body.querySelectorAll('.scp-ctx-hit').forEach(el => el.classList.remove('scp-ctx-hit', 'scp-ctx-hit-current'));
    _ctxSearchMatches = [];
    _ctxSearchIdx = -1;

    const q = (query || '').toLowerCase().trim();
    if (q) {
        body.querySelectorAll('.scp-ctx-block').forEach(block => {
            if ((block.textContent || '').toLowerCase().includes(q)) {
                block.classList.add('scp-ctx-hit');
                _ctxSearchMatches.push(block);
            }
        });
    }
    if (countEl) countEl.textContent = q ? `${_ctxSearchMatches.length ? '0' : '0'}/${_ctxSearchMatches.length}` : '';
}

function _ctxSearchGo(dir) {
    if (!_ctxSearchMatches.length) return;
    _ctxSearchIdx = (_ctxSearchIdx + dir + _ctxSearchMatches.length) % _ctxSearchMatches.length;
    _ctxSearchMatches.forEach(el => el.classList.remove('scp-ctx-hit-current'));
    const cur = _ctxSearchMatches[_ctxSearchIdx];
    cur.classList.add('scp-ctx-hit-current');
    const body = document.getElementById('scp-ctx-body');
    if (body) body.scrollTo({ top: cur.offsetTop - 8, behavior: 'smooth' });
    const countEl = document.getElementById('scp-ctx-search-count');
    if (countEl) countEl.textContent = `${_ctxSearchIdx + 1}/${_ctxSearchMatches.length}`;
}

export function setupContextSearch() {
    const input = document.getElementById('scp-ctx-search');
    if (!input) return;
    input.value = '';
    _ctxSearchApply('');
    if (_ctxSearchBound) return;
    _ctxSearchBound = true;
    input.addEventListener('input', () => _ctxSearchApply(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _ctxSearchGo(e.shiftKey ? -1 : 1); }
    });
    document.getElementById('scp-ctx-search-prev')?.addEventListener('click', () => _ctxSearchGo(-1));
    document.getElementById('scp-ctx-search-next')?.addEventListener('click', () => _ctxSearchGo(1));
}

export function _highlightContextText(raw) {
    const masterRe = /(```[\s\S]*?(?:```|$))|(`[^`\n]*`)|(<\/?([\w:{}_-]+)[^>]*>|<!--[\s\S]*?-->)|(\{\{[^}\n]+\}\})/gi;
    
    let m;
    masterRe.lastIndex = 0;
    let tempEvents = [];
    while ((m = masterRe.exec(raw)) !== null) {
        if (m[1] !== undefined) tempEvents.push({ start: m.index, end: masterRe.lastIndex, type: 'code_block', match: m[1] });
        else if (m[2] !== undefined) tempEvents.push({ start: m.index, end: masterRe.lastIndex, type: 'inline_code', match: m[2] });
        else if (m[3] !== undefined) tempEvents.push({ start: m.index, end: masterRe.lastIndex, type: 'tag', match: m[3], tagName: m[4] });
        else if (m[5] !== undefined) tempEvents.push({ start: m.index, end: masterRe.lastIndex, type: 'macro', match: m[5] });
    }

    const openStacks = {};
    const validTags = new Set();

    for (let i = 0; i < tempEvents.length; i++) {
        const ev = tempEvents[i];
        if (ev.type === 'tag') {
            const match = ev.match;
            if (match.startsWith('<!--') || match.endsWith('/>')) {
                validTags.add(ev.start);
            } else {
                const isClose = match.startsWith('</');
                const tagName = ev.tagName;
                if (!tagName) continue;

                if (isClose) {
                    if (openStacks[tagName] && openStacks[tagName].length > 0) {
                        const openEvIndex = openStacks[tagName].pop();
                        validTags.add(tempEvents[openEvIndex].start);
                        validTags.add(ev.start);
                    }
                } else {
                    if (!openStacks[tagName]) openStacks[tagName] = [];
                    openStacks[tagName].push(i);
                }
            }
        }
    }

    const events = [];
    for (const ev of tempEvents) {
        if (ev.type === 'tag' && !validTags.has(ev.start)) continue;
        events.push([ev.start, ev.end, ev.type, ev.match, ev.tagName]);
    }

    let html = '', last = 0;
    const KNOWN = new Set(['system_prompt','character_information','characters','character','lorebook_context','st_system_prompt','persistent_memory','summary_context','lorebook_management','character_management','chat_messages_editing','roleplay_context','entity_definitions','persona_configuration','operational_guidelines','{{user}}_persona', 'tool_calls_system', 'memory_system']);
    let currentDepth = 0;
    let emittedAnchors = new Set();

    for (const [start, end, type, match, tagName] of events) {
        if (start < last) continue;
        html += escHtml(raw.slice(last, start));
        
        if (type === 'tag') {
            const isClose = match.startsWith('</');
            const isSelfClose = match.endsWith('/>');
            const isComment = match.startsWith('<!--');

            let applyDepth;
            if (isComment || isSelfClose) {
                applyDepth = currentDepth;
            } else if (isClose) {
                currentDepth = Math.max(0, currentDepth - 1);
                applyDepth = currentDepth;
            } else {
                applyDepth = currentDepth;
                currentDepth++;
            }

            if (!isClose && !isComment && !isSelfClose && tagName) {
                if (KNOWN.has(tagName) || tagName.endsWith('_persona')) {
                    if (!emittedAnchors.has(tagName)) {
                        emittedAnchors.add(tagName);
                        html += `<span id="scp-ctx-sec-${tagName}" class="scp-ctx-anchor"></span>`;
                    }
                }
            }
            
            const depthClass = Math.min(applyDepth, 5);
            html += `<span class="scp-ctx-hl-tag scp-ctx-hl-tag-d${depthClass}">${escHtml(match)}</span>`;
        } else if (type === 'macro') {
            html += `<span class="scp-ctx-hl-macro">${escHtml(match)}</span>`;
        } else if (type === 'code_block' || type === 'inline_code') {
            html += escHtml(match);
        }
        last = end;
    }
    html += escHtml(raw.slice(last));
    return html;
}

export function _buildContextInspectorHTML(messages) {
    const SECTION_LABELS = {
        'system_prompt': 'Системный промпт',
        'persistent_memory': 'Постоянная память',
        'lorebook_context': 'Лорбук',
        'characters': 'Персонажи',
        '{{user}}_persona': 'Персона пользователя',
        'memory_system': 'Управление памятью',
        'lorebook_management': 'Управление лорбуком',
        'character_management': 'Управление персонажами',
        'chat_messages_editing': 'Управление чатом',
        'tool_calls_system': 'Вызовы инструментов'
    };
    const KNOWN_SECS = new Set(Object.keys(SECTION_LABELS));
    const ALIASES = {
        'character_information': 'characters',
        'character': 'characters'
    };
    const DISPLAY_ORDER = [
        'system_prompt',
        'persistent_memory',
        'lorebook_context',
        'characters',
        '{{user}}_persona',
        'memory_system',
        'lorebook_management',
        'character_management',
        'chat_messages_editing',
        'tool_calls_system'
    ];

    let navHtml = '', bodyHtml = '';
    let seenSections = new Set();
    
    messages.forEach((msg, idx) => {
        let raw = Array.isArray(msg.content)
            ? msg.content.map(p => p.type === 'text' ? p.text : '[Image]').join('\n')
            : (msg.content || '');

        let displayRole = msg.role;
        if (msg.role === 'user' && raw.includes('"type": "system_notification"')) {
            displayRole = 'system';
        }

        const LABELS = { system:'■ SYSTEM', user:'▶ USER', assistant:'◀ ASSISTANT' };
        const label = (LABELS[displayRole] || displayRole) + (idx > 0 ? ` #${idx}` : '');
        const blockId = `scp-ctx-b${idx}`;

        navHtml += `<button class="scp-ctx-nav-btn scp-ctx-nav-${displayRole}" data-t="${blockId}">${escHtml(label)}</button>`;

        if (msg.role === 'system') {
            const tagRe = /<([\w:{}_-]+)[^>]*>/g;
            let tm;
            tagRe.lastIndex = 0;
            let foundMain = [];
            let foundModules = [];

            while ((tm = tagRe.exec(raw)) !== null) {
                let rawTag = tm[1];
                let tag = ALIASES[rawTag] ? ALIASES[rawTag] : rawTag;
                
                const isUserPersona = tag === '{{user}}_persona' || tag.endsWith('_persona');
                const key = isUserPersona ? '{{user}}_persona' : tag;

                if ((KNOWN_SECS.has(key) || isUserPersona) && !seenSections.has(key)) {
                    seenSections.add(key);
                    const secLabel = SECTION_LABELS[key] || (isUserPersona ? 'Персона пользователя' : key);
                    const secId = `scp-ctx-sec-${rawTag}`;
                    
                    if (['memory_system','lorebook_management','character_management','chat_messages_editing', 'tool_calls_system'].includes(key)) {
                        foundModules.push({ key, id: secId, label: secLabel });
                    } else {
                        foundMain.push({ key, id: secId, label: secLabel });
                    }
                }
            }

            const sortFn = (a, b) => {
                let idxA = DISPLAY_ORDER.indexOf(a.key);
                let idxB = DISPLAY_ORDER.indexOf(b.key);
                if (idxA === -1) idxA = 999;
                if (idxB === -1) idxB = 999;
                return idxA - idxB;
            };

            foundMain.sort(sortFn);
            foundModules.sort(sortFn);

            foundMain.forEach(item => {
                navHtml += `<button class="scp-ctx-nav-btn scp-ctx-nav-sub" data-t="${item.id}">&nbsp;&nbsp;◦ ${escHtml(item.label)}</button>`;
            });

            let moduleNavs = '';
            foundModules.forEach(item => {
                moduleNavs += `<button class="scp-ctx-nav-btn scp-ctx-nav-sub" data-t="${item.id}">&nbsp;&nbsp;◦ ${escHtml(item.label)}</button>`;
            });

            if (moduleNavs) {
                 navHtml += `<details class="scp-ctx-nav-details" open><summary class="scp-ctx-nav-btn" style="color:var(--scp-text)">▼ Модули</summary>${moduleNavs}</details>`;
            }
        }

        const highlighted = _highlightContextText(raw);
        bodyHtml += `<div class="scp-ctx-block" id="${blockId}">`;
        bodyHtml += `<div class="scp-ctx-block-header scp-ctx-role-${displayRole}">${escHtml(label)}</div>`;
        bodyHtml += `<div class="scp-ctx-block-sep"></div>`;
        bodyHtml += `<div class="scp-ctx-block-body"><pre class="scp-ctx-pre">${highlighted}</pre></div>`;
        bodyHtml += `</div>`;
    });

    const styleHtml = `<style>
        .scp-ctx-hl-tag-d0 { color: #eff6ff !important; }
        .scp-ctx-hl-tag-d1 { color: #bfdbfe !important; }
        .scp-ctx-hl-tag-d2 { color: #93c5fd !important; }
        .scp-ctx-hl-tag-d3 { color: rgb(106, 165, 236) !important; }
        .scp-ctx-hl-tag-d4 { color: rgb(100, 158, 253) !important; }
        .scp-ctx-hl-tag-d5 { color: rgb(74, 120, 221) !important; }
    </style>`;

    return `<div class="scp-ctx-inspector">${styleHtml}<nav class="scp-ctx-nav">${navHtml}</nav><div class="scp-ctx-body" id="scp-ctx-body">${bodyHtml}</div></div>`;
}

export let _lastInspectorMessages = [];

export async function openInspector() {
    const sess = getCurrentSession();
    const { getEffectiveSettings } = await import('../session.js');
    const settings = getEffectiveSettings();
    const inputEl = document.getElementById('scp-input');
    const pendingText = inputEl ? inputEl.value.trim() : '';
    const processedAtts = await _processAttachmentsBeforeSend(state.pendingAttachments, true);
    
    const messages = await assembleMessages(sess, settings, pendingText, processedAtts);
    _lastInspectorMessages = messages;

    const fmtEl = document.getElementById('scp-ctx-formatted');
    const jsonEl = document.getElementById('scp-ctx-json');
    const modalEl = document.getElementById('scp-ctx-modal');
    
    const modal = modalEl.querySelector('.scp-modal');
    if (modal) {
        modal.style.height = '75vh';
    }
    
    const modalBody = modalEl.querySelector('.scp-modal-body');
    if (modalBody) {
        modalBody.style.padding = '0';
        modalBody.style.overflow = 'hidden';
        modalBody.style.display = 'flex';
        modalBody.style.flexDirection = 'column';
        modalBody.style.height = '100%';
    }

    if (fmtEl) {
        fmtEl.style.height = '100%';
        fmtEl.style.flex = '1';
        fmtEl.style.overflow = 'hidden';
        fmtEl.style.padding = '0';
        fmtEl.innerHTML = _buildContextInspectorHTML(messages);
        
        setupContextSearch();

        fmtEl.querySelectorAll('.scp-ctx-nav-btn[data-t]').forEach(btn => {
            btn.addEventListener('click', () => {
                const t = document.getElementById(btn.dataset.t);
                const bodyContainer = document.getElementById('scp-ctx-body');
                if (t && bodyContainer) {
                    const topPos = t.offsetTop;
                    bodyContainer.scrollTo({ top: topPos, behavior: 'smooth' });
                }
            });
        });
    }
    if (jsonEl) jsonEl.textContent = JSON.stringify(messages, null, 2);
    const lsEl = document.getElementById('scp-ctx-lastsent');
    if (lsEl) {
        const log = state.requestLog || [];
        lsEl.textContent = log.length
            ? log.slice().reverse().map(e =>
                `═══ ${new Date(e.ts).toLocaleTimeString()} — ${e.url} ═══\n${JSON.stringify(e.body, null, 2)}`
            ).join('\n\n')
            : 'Запросов ещё не было. Журнал хранит последние 5 тел запросов (секреты вымыты) и очищается при перезагрузке страницы.';
    }
    modalEl.style.display = 'flex';
    import('./ui-window.js').then(m => m.bringWindowToFront());
    
    setTimeout(() => {
        const isJsonActive = document.querySelector('.scp-modal-tab.active')?.dataset.tab === 'json';
        const targetEl = isJsonActive ? jsonEl : document.getElementById('scp-ctx-body');
        if (targetEl) {
            const prevBehavior = targetEl.style.scrollBehavior;
            targetEl.style.scrollBehavior = 'auto';
            targetEl.scrollTop = targetEl.scrollHeight;
            targetEl.style.scrollBehavior = prevBehavior;
        }
    }, 0);
}
