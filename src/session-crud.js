import { EXT_DISPLAY } from './constants.js';
import { _dbgAdd } from './utils/util-debug.js';
import { showCustomDialog, escHtml } from './utils/util-dom.js';
import { invalidateSystemPromptCache } from './state.js';
import { getBindingKey, getSettings } from './session-settings.js';
import { getChatBucket, saveSessionsToMetadata } from './session-storage.js';

// ─── Session Override System ─────────────────────────────────────────────────
export function getSessionOverrides() {
    try { return getActiveSession(false)?.overrides || {}; } catch(_) { return {}; }
}

export function getEffectiveSettings() {
    return { ...getSettings(), ...getSessionOverrides() };
}

export function setSessionOverride(key, value) {
    try {
        const sess = getCurrentSession();
        if (!sess) return;
        if (!sess.overrides) sess.overrides = {};
        if (value === undefined || value === null) delete sess.overrides[key];
        else sess.overrides[key] = value;
        saveSessionsToMetadata();
        import('./ui/ui-settings.js').then(m => m.updateSessionOverrideIndicator());
    } catch(_) {}
}

export function clearAllSessionOverrides() {
    try {
        const sess = getCurrentSession();
        if (!sess) return;
        sess.overrides = {};
        saveSessionsToMetadata();
        import('./ui/ui-settings.js').then(m => m.updateSessionOverrideIndicator());
    } catch(_) {}
}

export function hasSessionOverrides() {
    try { const o = getActiveSession(false)?.overrides; return !!(o && Object.keys(o).length > 0); }
    catch(_) { return false; }
}

// ─── Session Helpers ─────────────────────────────────────────────────────────

export function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

export function createSession(name, isTemporary = false, recordStats = true) {
    const bucket = getChatBucket();
    const id = genId('sess');
    const sess = { id, name: name || `Сессия ${bucket.sessions.length + 1}`, created: Date.now(), messages: [], isTemporary };

    if (recordStats) {
        const prev = bucket.sessions.find(s => s.id === bucket.activeSessionId);
        if (prev && prev.isTemporary) {
            bucket.sessions = bucket.sessions.filter(s => s.id !== prev.id);
        }
    }

    bucket.sessions.push(sess);
    bucket.activeSessionId = id;
    // Same contract as setActiveSession: the active session feeds getVisibleMemories,
    // which feeds buildSystemContent. Without this the first request of the new
    // session reuses the previous session's cached prompt (session-scoped memory leak).
    invalidateSystemPromptCache('createSession');

    if (recordStats) {
        import('./features/feature-stats.js').then(m => m.recordStat(m.SM.sess));
    }
    saveSessionsToMetadata();
    _dbgAdd('SESSION_CREATED', { id: sess.id, name: sess.name, isTemporary });
    return sess;
}

export function getActiveSession(autoCreate = true) {
    const bucket = getChatBucket();
    if (!bucket.sessions.length || !bucket.activeSessionId) {
        return autoCreate ? createSession(undefined, false, false) : null;
    }
    const sess = bucket.sessions.find(s => s.id === bucket.activeSessionId);
    if (sess) return sess;
    return autoCreate ? createSession(undefined, false, false) : null;
}

export function setActiveSession(sessionId) {
    const bucket = getChatBucket();
    if (!bucket.sessions.find(s => s.id === sessionId)) return;
    const prev = bucket.sessions.find(s => s.id === bucket.activeSessionId);
    if (prev && prev.isTemporary && prev.id !== sessionId) {
        bucket.sessions = bucket.sessions.filter(s => s.id !== prev.id);
    }
    bucket.activeSessionId = sessionId;
    saveSessionsToMetadata();
    // Активная сессия задаёт pickedChatIndices / getMainChatSlice — это прямые входы
    // assembleMessages (а значит и косвенно системный промпт черезpicked msgs).
    invalidateSystemPromptCache('setActiveSession');
    _dbgAdd('SESSION_SWITCHED', { id: sessionId });
}

export function deleteCurrentSession() {
    const bucket = getChatBucket();
    if (!bucket.sessions.length) return createSession();
    const deletedId = bucket.activeSessionId;
    bucket.sessions = bucket.sessions.filter(s => s.id !== bucket.activeSessionId);
    bucket.activeSessionId = bucket.sessions.length ? bucket.sessions[bucket.sessions.length - 1].id : null;
    invalidateSystemPromptCache('deleteCurrentSession');
    saveSessionsToMetadata();
    _dbgAdd('SESSION_DELETED', { id: deletedId });
    return getActiveSession(true);
}

export function getCurrentSession() {
    return getActiveSession(true);
}

export function addMessage(session, role, content, extra = {}) {
    const msg = { id: genId('msg'), role, content, timestamp: Date.now(), ...extra };
    session.messages.push(msg);
    if (session.messages.length > 400) session.messages = session.messages.slice(-400);
    saveSessionsToMetadata();
    return msg;
}

export function truncateAfter(session, msgId) {
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx !== -1) { session.messages.splice(idx + 1); saveSessionsToMetadata(); }
}

export function deleteMsg(session, msgId) {
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx !== -1) { session.messages.splice(idx, 1); saveSessionsToMetadata(); }
}

export function truncateFrom(session, msgId) {
    const idx = session.messages.findIndex(m => m.id === msgId);
    if (idx !== -1) { session.messages.splice(idx); saveSessionsToMetadata(); }
}

// ─── Session Import/Export Dialogs ──────────────────────────────────────────

export function exportCurrentSession() {
    try {
        const sess = getCurrentSession();
        const { charId, chatId } = getBindingKey();
        const ctx = SillyTavern.getContext();
        const charName = ctx.characters?.[ctx.characterId]?.name || 'unknown';
        const exportData = {
            version: 1,
            exported: new Date().toISOString(),
            charName,
            session: JSON.parse(JSON.stringify(sess)),
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = sess.name.replace(/[^a-z0-9]/gi, '_').slice(0, 40) || 'session';
        a.download = `st-copilot-session-${safeName}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Сессия экспортирована.', EXT_DISPLAY);
    } catch (e) {
        toastr.error(`Ошибка экспорта: ${e.message}`, EXT_DISPLAY);
    }
}

export function importSession(onSuccessCallback) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
        const file = inp.files?.[0]; if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.session || !data.session.id || !Array.isArray(data.session.messages)) {
                toastr.error('Недействительный файл сессии.', EXT_DISPLAY); return;
            }
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Импорт сессии',
                message: `Импортировать сессию «${data.session.name || 'безымянная'}»${data.charName ? ` (от ${data.charName})` : ''}? Она будет добавлена в метаданные текущего чата.`,
            });
            if (!ok) return;
            const bucket = getChatBucket();
            const imported = { ...data.session, id: genId('sess'), name: `${data.session.name || 'Импортированная'} (импорт)` };
            imported.isTemporary = false;
            bucket.sessions.push(imported);
            bucket.activeSessionId = imported.id;
            invalidateSystemPromptCache('importSession');
            saveSessionsToMetadata();
            toastr.success(`Сессия «${escHtml(imported.name)}» импортирована.`, EXT_DISPLAY);
            if (onSuccessCallback) onSuccessCallback();
        } catch (e) {
            toastr.error(`Ошибка импорта: ${e.message}`, EXT_DISPLAY);
        }
    };
    inp.click();
}

export function showSessionDialog({ defaultName = '' } = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'scp-dialog-overlay';
        overlay.style.zIndex = '2147483050';
        overlay.innerHTML = `
            <div class="scp-dialog-box">
                <div class="scp-dialog-title">Новая сессия</div>
                <div class="scp-dialog-msg">Имя сессии:</div>
                <input type="text" class="scp-dialog-input" value="${escHtml(defaultName)}" placeholder="${escHtml(defaultName)}">
                <label class="scp-sess-tmp-label">
                    <div class="scp-lb-toggle" id="scp-sess-tmp-toggle"><div class="scp-lb-toggle-knob"></div></div>
                    <span>Временная — автоудаление при переключении</span>
                </label>
                <div class="scp-dialog-btns">
                    <button class="scp-dialog-btn scp-dialog-cancel">Отмена</button>
                    <button class="scp-dialog-btn scp-dialog-ok">Создать</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        let isTemporary = false;
        const toggle = overlay.querySelector('#scp-sess-tmp-toggle');
        toggle.addEventListener('click', () => {
            isTemporary = !isTemporary;
            toggle.classList.toggle('active', isTemporary);
        });
        const input = overlay.querySelector('.scp-dialog-input');
        const okBtn = overlay.querySelector('.scp-dialog-ok');
        const cancelBtn = overlay.querySelector('.scp-dialog-cancel');
        const close = val => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 150); resolve(val); };
        input.focus(); input.select();
        okBtn.addEventListener('click', () => close({ name: input.value, isTemporary }));
        cancelBtn.addEventListener('click', () => close(null));
        let _mdTarget = null;
        overlay.addEventListener('mousedown', e => { _mdTarget = e.target; });
        overlay.addEventListener('click', e => { if (e.target === overlay && _mdTarget === overlay) close(null); });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); close({ name: input.value, isTemporary }); }
            if (e.key === 'Escape') close(null);
        });
        requestAnimationFrame(() => overlay.classList.add('visible'));
    });
}
