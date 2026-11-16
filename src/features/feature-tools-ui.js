import { DEFAULT_TOOLS_PROMPT, TOOL_DEFINITIONS } from '../constants.js';
import { escHtml } from '../utils/util-dom.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { getSettings, saveSettings } from '../session.js';
import { openSettingsPanel } from '../ui/ui-settings.js';

export function createToolCallEl(tc) {
    const item = document.createElement('div');
    item.className = 'scp-tool-call-item scp-inline-tool-call';
    item.dataset.toolId = tc.id;
    const def = TOOL_DEFINITIONS.find(d => d.name === tc.name);
    const iconClass = def?.icon || 'fa-screwdriver-wrench';
    
    const isWarning = tc.status === 'warning';
    const statusClass = tc.status === 'running' ? 'running' : tc.status === 'error' ? 'error' : isWarning ? 'warning' : 'done';
    const statusLabel = tc.status === 'running' ? 'Выполняется' : tc.status === 'error' ? 'Ошибка' : isWarning ? 'Недоступно' : 'Готово';
    const colorStyle = isWarning ? 'color: var(--scp-warning, #ffb432);' : '';

    const spinnerHtml = tc.status === 'running' ? '<span class="scp-tool-spin">⟳</span> ' : '';
    const iconHtml = tc.status === 'running'
        ? '<span class="scp-tool-spin" style="font-size:11px">⟳</span>'
        : `<i class="fa-solid ${iconClass}" style="font-size:11px"></i>`;

    item.innerHTML = `<div class="scp-tool-call-header">
<div class="scp-tool-call-icon ${statusClass}" ${isWarning ? `style="${colorStyle}"` : ''}>${iconHtml}</div>
<div class="scp-tool-call-name">${escHtml(def?.label || tc.name)}</div>
<div class="scp-tool-call-status ${statusClass}" ${isWarning ? `style="${colorStyle}"` : ''}>${spinnerHtml}${escHtml(statusLabel)}</div>
<div class="scp-tool-call-chevron">▶</div>
</div>
<div class="scp-tool-call-body">
<div class="scp-tool-call-section-label">Ввод</div>
<pre class="scp-tool-call-args">${escHtml(JSON.stringify(tc.input, null, 2))}</pre>
${tc.result !== undefined ? `<div class="scp-tool-call-section-label" style="margin-top:8px">Результат</div><pre class="scp-tool-call-result${tc.status === 'error' ? ' error-result' : ''}" ${isWarning ? `style="${colorStyle}"` : ''}>${escHtml(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2))}</pre>` : ''}
</div>`;
    item.querySelector('.scp-tool-call-header').addEventListener('click', () => {
        const isOpen = !item.classList.contains('open');
        _dbgAdd('TOOL_CALL_HEADER_TOGGLE', { toolId: tc.id, open: isOpen });
        item.classList.toggle('open');
    });
    return item;
}

export function postProcessToolCalls(containerEl, toolCalls) {
    if (!toolCalls || !toolCalls.length) return;
    containerEl.querySelectorAll('.scp-tool-call-ph').forEach((ph) => {
        const idx = parseInt(ph.dataset.tcid, 10);
        const tc = toolCalls[idx];
        if (tc) ph.replaceWith(createToolCallEl(tc));
    });

    const allTCs = [...containerEl.querySelectorAll('.scp-inline-tool-call')];
    allTCs.forEach(tc => tc.classList.remove('scp-tc-chain-start','scp-tc-chain-mid','scp-tc-chain-end'));
    
    let i = 0;
    while (i < allTCs.length) {
        let end = i;
        while (end + 1 < allTCs.length) {
            let sib = allTCs[end].nextSibling;
            while (sib && ((sib.nodeType === Node.TEXT_NODE && !sib.textContent.trim()) || sib.tagName === 'BR')) {
                sib = sib.nextSibling;
            }
            if (sib === allTCs[end + 1]) end++; else break;
        }
        if (end > i) {
            for (let j = i; j <= end; j++) {
                if (j === i) allTCs[j].classList.add('scp-tc-chain-start');
                else if (j === end) allTCs[j].classList.add('scp-tc-chain-end');
                else allTCs[j].classList.add('scp-tc-chain-mid');
            }
        } else {
            allTCs[i].classList.add('scp-tc-chain-start', 'scp-tc-chain-end');
        }
        i = end + 1;
    }

    collapseToolChains(containerEl);
}

// Collapse long chains (ChatGPT/Codex "Searched the web" pattern): consecutive
// finished cards fold behind one summary header. Idempotent — safe on every
// postProcess pass; existing groups just refresh their summary/status.
const TC_COLLAPSE_DEFAULT_MIN = 3;

function toolGroupStatus(cards) {
    if (cards.some(c => c.querySelector('.scp-tool-call-status.running'))) return 'running';
    if (cards.some(c => c.querySelector('.scp-tool-call-status.error'))) return 'error';
    return 'done';
}

function toolGroupSummary(cards, status) {
    const counts = new Map();
    for (const c of cards) {
        const label = c.querySelector('.scp-tool-call-name')?.textContent?.trim() || 'инструмент';
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    const parts = [...counts.entries()].map(([l, n]) => n > 1 ? `${l.toLowerCase()} ×${n}` : l.toLowerCase());
    const statusText = status === 'running' ? 'Выполняется…' : status === 'error' ? 'Есть ошибка' : 'Готово';
    return { head: `${cards.length} вызов(ов) · ${parts.join(' · ')}`, statusText };
}

function refreshToolGroup(group) {
    const body = group.querySelector('.scp-tc-group-body');
    const cards = body ? [...body.querySelectorAll(':scope > .scp-inline-tool-call')] : [];
    if (!cards.length) { group.remove(); return; }
    const status = toolGroupStatus(cards);
    const { head, statusText } = toolGroupSummary(cards, status);
    const sumEl = group.querySelector('.scp-tc-group-summary');
    const stEl = group.querySelector('.scp-tc-group-status');
    if (sumEl) sumEl.textContent = head;
    if (stEl) { stEl.textContent = statusText; stEl.className = `scp-tc-group-status ${status}`; }
}

function collapseToolChains(containerEl) {
    const s = getSettings();
    if (s.toolsCollapseChains === false) return;
    const min = Math.max(2, parseInt(s.toolsCollapseThreshold ?? TC_COLLAPSE_DEFAULT_MIN, 10) || TC_COLLAPSE_DEFAULT_MIN);

    // Refresh statuses of groups built on an earlier pass.
    containerEl.querySelectorAll('.scp-tc-group').forEach(refreshToolGroup);

    // Collect top-level consecutive runs that are not already inside a group.
    const allTCs = [...containerEl.querySelectorAll('.scp-inline-tool-call')]
        .filter(c => !c.closest('.scp-tc-group'));
    let i = 0;
    while (i < allTCs.length) {
        let end = i;
        while (end + 1 < allTCs.length) {
            let sib = allTCs[end].nextSibling;
            while (sib && ((sib.nodeType === Node.TEXT_NODE && !sib.textContent.trim()) || sib.tagName === 'BR')) sib = sib.nextSibling;
            if (sib === allTCs[end + 1]) end++; else break;
        }
        const run = allTCs.slice(i, end + 1);
        if (run.length >= min) {
            const group = document.createElement('div');
            group.className = 'scp-tc-group';
            const status = toolGroupStatus(run);
            const { head, statusText } = toolGroupSummary(run, status);
            const header = document.createElement('div');
            header.className = 'scp-tc-group-header';
            header.innerHTML = `<i class="fa-solid fa-screwdriver-wrench" style="font-size:11px;opacity:.7"></i>` +
                `<span class="scp-tc-group-summary">${escHtml(head)}</span>` +
                `<span class="scp-tc-group-status ${status}">${escHtml(statusText)}</span>` +
                `<span class="scp-tc-group-chevron">▶</span>`;
            const body = document.createElement('div');
            body.className = 'scp-tc-group-body';
            header.addEventListener('click', () => group.classList.toggle('open'));
            group.append(header, body);
            run[0].before(group);
            body.append(...run);
            // Live pass: keep the group open while something is still running or failed.
            if (status !== 'done') group.classList.add('open');
        }
        i = end + 1;
    }
}

let _toolsUIBound = false;
let _toolsOpenBound = false;

export function setupToolsSettingsUI() {
    const s = getSettings();
    const listEl = document.getElementById('scp-sp-tools-list');
    if (!listEl) return;
    
    const ta = document.getElementById('scp-sp-tools-prompt');
    if (ta) ta.value = s.toolsSystemPrompt || '';

    // Функция вызывается при каждом открытии вкладки, а узлы оверлея постоянные —
    // обработчики на статичные контролы вешаем один раз, иначе они накапливаются.
    if (!_toolsUIBound) {
        _toolsUIBound = true;
        if (ta) ta.addEventListener('input', () => { getSettings().toolsSystemPrompt = ta.value; saveSettings(); });

        document.getElementById('scp-sp-tools-reset')?.addEventListener('click', () => {
            getSettings().toolsSystemPrompt = DEFAULT_TOOLS_PROMPT; saveSettings();
            if (ta) ta.value = DEFAULT_TOOLS_PROMPT;
        });

    document.getElementById('scp-sp-tools-enabled')?.addEventListener('change', e => {
            getSettings().toolsEnabled = e.target.checked; saveSettings();
            const stEl = document.getElementById('scp-tools-enabled'); if (stEl) stEl.checked = e.target.checked;
        });
        document.getElementById('scp-sp-tools-max-rounds')?.addEventListener('input', e => {
            getSettings().toolsMaxRounds = parseInt(e.target.value) || 5; saveSettings();
        });
        document.getElementById('scp-sp-tools-gen-retry')?.addEventListener('input', e => {
            getSettings().toolsGenRetryMax = Math.max(0, Math.min(3, parseInt(e.target.value) || 0)); saveSettings();
        });
        document.getElementById('scp-sp-tools-collapse')?.addEventListener('change', e => {
            getSettings().toolsCollapseChains = e.target.checked; saveSettings();
        });
        document.getElementById('scp-sp-tools-collapse-min')?.addEventListener('input', e => {
            getSettings().toolsCollapseThreshold = Math.max(2, Math.min(10, parseInt(e.target.value) || 3)); saveSettings();
        });

        const protoSel = document.getElementById('scp-sp-tools-protocol');
        if (protoSel) {
            protoSel.addEventListener('change', () => {
                getSettings().toolsProtocol = protoSel.value === 'native' ? 'native' : 'text';
                saveSettings();
            });
        }
    }

    // Синк значений — при каждом открытии вкладки (снаружи bind-once guard).
    const setC = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const setV = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    setC('scp-sp-tools-enabled', s.toolsEnabled);
    setV('scp-sp-tools-max-rounds', s.toolsMaxRounds ?? 5);
    setV('scp-sp-tools-gen-retry', s.toolsGenRetryMax ?? 1);
    setC('scp-sp-tools-collapse', s.toolsCollapseChains !== false);
    setV('scp-sp-tools-collapse-min', s.toolsCollapseThreshold ?? 3);

    const protoSel2 = document.getElementById('scp-sp-tools-protocol');
    if (protoSel2) protoSel2.value = s.toolsProtocol === 'native' ? 'native' : 'text';

    const streamingOff = s.forceStreaming === 'off';

    listEl.innerHTML = '';
    for (const tool of TOOL_DEFINITIONS) {
        const row = document.createElement('div');
        row.className = 'scp-tool-toggle-row';
        const isEnabled = s[tool.settingKey] !== false;
        const isAskUser = tool.id === 'ask_user';
        const isDisabledByStream = isAskUser && streamingOff;
        const iconHtml = `<i class="fa-solid ${tool.icon}" style="width:13px;text-align:center;margin-right:4px;opacity:.7"></i>`;
        row.innerHTML = `<label class="scp-sp-check" style="flex:1${isDisabledByStream ? ';opacity:.45;pointer-events:none' : ''}"><input type="checkbox" id="scp-sp-tool-${tool.id}" ${isEnabled && !isDisabledByStream ? 'checked' : ''} ${isDisabledByStream ? 'disabled' : ''}><span class="scp-tool-toggle-name">${iconHtml}${escHtml(tool.label)}</span></label>`;
        const descEl = document.createElement('div');
        descEl.className = 'scp-tool-toggle-desc';
        descEl.style.cssText = 'font-size:10px;color:var(--scp-text-muted);margin-top:2px;padding-left:20px';
        descEl.textContent = isDisabledByStream ? '⚠ Недоступно — требуется включить стриминг (не «Принудительно выключен»)' : tool.description;
        if (isDisabledByStream) descEl.style.color = 'var(--scp-danger)';
        row.appendChild(descEl);
        if (!isDisabledByStream) {
            row.querySelector(`#scp-sp-tool-${tool.id}`)?.addEventListener('change', e => {
                getSettings()[tool.settingKey] = e.target.checked; saveSettings();
            });
        }
        listEl.appendChild(row);
    }

    if (!_toolsOpenBound) {
        _toolsOpenBound = true;
        document.getElementById('scp-open-tools-settings')?.addEventListener('click', () => {
        openSettingsPanel();
            setTimeout(() => {
                const tab = document.querySelector('[data-sptab="tools"]');
                if (tab) tab.click();
            }, 80);
        });
    }
}

let askUserResolve = null;
let askUserWrap = null;

// Resolves a pending ask_user without an answer. Called when the question is
// superseded by a new one; generation stop / chat switch are covered by the
// generationStopped polling in the api.js round executor.
export function cancelPendingAskUser(reason = 'cancelled') {
    if (!askUserResolve) return;
    const r = askUserResolve;
    askUserResolve = null;
    askUserWrap?.remove();
    askUserWrap = null;
    r({ __ask_cancelled: true, reason });
}

export async function executeAskUser(input, msgEl) {
    const question = input.question || 'Есть ли у вас дополнительная информация?';
    const context = input.context || '';
    return new Promise(resolve => {
        cancelPendingAskUser('superseded');
        askUserResolve = resolve;
        askUserWrap = null; // re-assigned below once built
        const wrap = document.createElement('div');
        wrap.className = 'scp-tool-ask-wrap';
        if (context) {
            const ctx = document.createElement('div');
            ctx.style.cssText = 'font-size:10px;color:var(--scp-text-muted);margin-bottom:6px;font-style:italic';
            ctx.textContent = context;
            wrap.appendChild(ctx);
        }
        const q = document.createElement('div');
        q.className = 'scp-tool-ask-question';
        q.textContent = question;
        wrap.appendChild(q);
        const inp = document.createElement('textarea');
        inp.className = 'scp-tool-ask-input';
        inp.placeholder = 'Ваш ответ…';
        inp.rows = 2;
        wrap.appendChild(inp);
        const btn = document.createElement('button');
        btn.className = 'scp-tool-ask-submit';
        btn.textContent = 'Отправить ответ';
        btn.addEventListener('click', () => {
            const answer = inp.value.trim();
            if (!answer) return;

            _dbgAdd('ASK_USER_SUBMIT', { question, answer });

            wrap.remove();
            askUserWrap = null;
            askUserResolve = null;
            resolve(answer);
        });
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btn.click(); }
        });
        wrap.appendChild(btn);
        askUserWrap = wrap;
        const body = msgEl?.querySelector('.scp-msg-body');
        if (body) body.appendChild(wrap);
        inp.focus();
    });
}