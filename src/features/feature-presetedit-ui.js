// Proposal cards for AI preset edits. One card per message: op list + content
// diff + Apply all / Reject. Deliberately simpler than the chat-edit cards —
// no per-item editable fields, no persistence across reloads (the raw
// preset-changes block stays in msg.content until resolved, so an unresolved
// card simply re-appears on re-render).

import { EXT_DISPLAY } from '../constants.js';
import { applyPresetChanges, stripPresetChangesBlock } from './feature-presetedit-engine.js';
import { getCurrentSession, saveSessionsToMetadata } from '../session.js';
import { escHtml } from '../utils/util-dom.js';

const ACTION_LABELS = {
    add_variant: '<i class="fa-solid fa-clone" style="margin-right:4px;"></i> Вариант',
    edit: '<i class="fa-solid fa-pen-to-square" style="margin-right:4px;"></i> Правка',
    toggle: '<i class="fa-solid fa-toggle-on" style="margin-right:4px;"></i> Тоггл',
};

function _diffRow(label, before, after) {
    return `<div class="scp-pe-diff"><div class="scp-pe-diff-label">${escHtml(label)}</div>`
        + `<div class="scp-pe-diff-before">${escHtml(String(before ?? '').slice(0, 400) || '—')}</div>`
        + `<div class="scp-pe-diff-after">${escHtml(String(after ?? '').slice(0, 400) || '—')}</div></div>`;
}

function _opRow(change, orderEntries, prompts) {
    const label = ACTION_LABELS[change.action] || escHtml(change.action);
    let target = '';
    let diff = '';
    if (change.action === 'add_variant') {
        const t = prompts.find(p => p.identifier === change.target_identifier);
        target = `«${escHtml(t?.name || change.target_identifier)}»`;
        diff = _diffRow('Контент', t?.content ?? '(маркер — не найден)', change.content);
    } else {
        const t = prompts.find(p => p.identifier === change.identifier);
        const entry = orderEntries.find(e => e.identifier === change.identifier);
        target = `«${escHtml(t?.name || change.identifier)}»`;
        if (change.action === 'edit') {
            for (const [k, v] of Object.entries(change.fields || {})) {
                diff += _diffRow(k, t?.[k], v);
            }
        } else if (change.action === 'toggle') {
            diff = _diffRow('Включён', entry ? entry.enabled : '(нет в порядке)', change.enabled === undefined ? 'переключить' : !!change.enabled);
        }
    }
    return `<div class="scp-lb-proposal-item scp-pe-item"><div class="scp-pe-op">${label} ${target}</div>${diff}</div>`;
}

export function renderPresetProposalCard(changes, msgEl, presetName) {
    if (!changes?.length) return;
    document.querySelector(`.scp-preset-proposal-card[data-for="${msgEl.dataset.id}"]`)?.remove();

    const ctx = SillyTavern.getContext();
    const oai = ctx.chatCompletionSettings || {};
    const promptsRef = oai.prompts;
    const prompts = Array.isArray(oai.prompts) ? oai.prompts : [];
    const orderEntry = (oai.prompt_order || []).find(o => Number(o.character_id) === 100001);
    const orderEntries = orderEntry?.order || [];

    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card scp-preset-proposal-card';
    card.dataset.for = msgEl.dataset.id;
    card.style.margin = '8px 0 0 0';

    const hdr = document.createElement('div');
    hdr.className = 'scp-lb-proposal-header';
    hdr.innerHTML = `<div class="scp-lb-proposal-title"><i class="fa-solid fa-sliders" style="margin-right:6px;"></i>`
        + `Правки пресета <b>${escHtml(presetName || oai.preset_settings_openai || '')}</b>`
        + `<span class="scp-lb-count-badge">${changes.length}</span></div>`;

    const list = document.createElement('div');
    list.className = 'scp-lb-proposal-list';
    list.innerHTML = changes.map(c => _opRow(c, orderEntries, prompts)).join('');

    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'scp-lb-proposal-apply';
    applyBtn.textContent = 'Применить всё';
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'scp-lb-proposal-reject';
    rejectBtn.textContent = 'Отклонить';

    const finish = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (msg) {
            msg.content = stripPresetChangesBlock(msg.content);
            if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
            saveSessionsToMetadata();
        }
        card.remove();
    };

    applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Применение…';
        try {
            const res = await applyPresetChanges(changes, presetName, promptsRef);
            if (res.error) {
                toastr.error(res.error, EXT_DISPLAY, { timeOut: 12000 });
                applyBtn.disabled = false;
                applyBtn.textContent = 'Применить всё';
                return;
            }
            const skippedNote = res.skipped?.length ? `, пропущено ${res.skipped.length}` : '';
            toastr.success(`Пресет обновлён (${res.applied.length}${skippedNote})`
                + (res.snapshotName ? `. Снапшот: «${res.snapshotName}»` : ''), EXT_DISPLAY, { timeOut: 12000 });
            finish();
        } catch (e) {
            toastr.error(`Ошибка: ${e.message}`, EXT_DISPLAY);
            applyBtn.disabled = false;
            applyBtn.textContent = 'Применить всё';
        }
    });

    rejectBtn.addEventListener('click', finish);

    footer.appendChild(applyBtn);
    footer.appendChild(rejectBtn);
    card.appendChild(hdr);
    card.appendChild(list);
    card.appendChild(footer);

    const body = msgEl.querySelector('.scp-msg-body');
    if (body) body.insertBefore(card, body.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
}
