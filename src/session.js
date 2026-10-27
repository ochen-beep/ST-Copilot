import {
    EXT_NAME,
    EXT_DISPLAY,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_MEMORY_PROMPT,
    DEFAULT_LB_MANAGE_PROMPT,
    THEME_PRESETS
} from './constants.js';
import { _dbgAdd, _dbgDiffSettings } from './utils/util-debug.js';
import { _repairJSON } from './utils/util-text.js';
import { invalidateSystemPromptCache } from './state.js';

// ─── Settings ───────────────────────────────────────────────────────────────
// Дефолты hoist'нуты на уровень модуля: getSettings() вызывается очень часто
// (каждый кадр физики лаунчера, каждый getEffectiveSettings, каждый recordStat),
// пересоздавать литерал из ~100 ключей на вызов — чистый churn.
const DEFAULT_SETTINGS = {
    enabled: true,
    performanceMode: true,
    windowVisible: false,
    minimized: false,
    windowX: null, windowY: null,
    windowW: 440, windowH: 600,
    opacity: 95,
    hotkey: 'Alt+Shift+C',
    hotkeyEnabled: true,
    searchHotkey: 'Ctrl+F',
    searchHotkeyEnabled: true,
    contextDepth: 15,
    localHistoryLimit: 50,
    connectionSource: 'default',
    connectionProfileId: '',
    customUrl: 'http://localhost:5000/v1',
    customKey: '',
    customModel: '',
    maxTokens: 8048,
    includeSystemPrompt: false,
    includeAuthorsNote: true,
    includeCharacterCard: true,
    includeUserPersonality: true,
    includeAlternateSwipes: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    memoryManagePrompt: DEFAULT_MEMORY_PROMPT,
    profiles: {},
    activeProfile: '',
    profileBindings: {},
    customTheme: { ...THEME_PRESETS.default },
    savedThemes: {},
    activeThemeProfile: '',
    sessions: {},
    lorebookEnabled: true,
    lorebookAutoKeyword: true,
    lorebookSelectedBooks: [],
    lorebookEntryOverrides: {},
    lorebookAIManageEnabled: true,
    lorebookManagePrompt: DEFAULT_LB_MANAGE_PROMPT,
    lorebookSTScanDepth: 5,
    lorebookCopilotScanDepth: 6,
    floatingIconPersistent: false,
    reasoningTrimStrings: '',
    ghostModeOpacity: 15,
    ghostModeHotkey: 'Alt+Shift+G',
    ghostModeHotkeyEnabled: true,
    quickPromptsVisible: false,
    quickPrompts: [
        { id: 'qp_d1', label: 'Анализ', icon: '🔍', text: 'Analyze the current scene and character motivations in detail.' },
        { id: 'qp_d2', label: 'Идеи', icon: '💡', text: 'Give me 3 creative plot twist ideas for the current scene.' },
        { id: 'qp_d3', label: 'Сводка', icon: '📋', text: 'Summarize everything that has happened in the roleplay so far.' },
        { id: 'qp_d4', label: 'Чувства', icon: '💭', text: 'What is {{char}} likely feeling right now and why?' },
        { id: 'qp_d5', label: 'Дальше?', icon: '🎯', text: 'What are the most interesting directions the story could go next?' },
    ],
    quickPromptSets: {},
    activeQuickPromptSet: '',
    promptPresets: {},
    stats: { g:{}, c:{}, ch:{} },
    changelogAutoShow: true,
    lastSeenVersion: '',
    starredMessages: {},
    forceStreaming: 'auto',
    applyRegexToContext: true,
    charEditAIEnabled: true,
    charEditPrompt: '',
    charEditFields: {
        tags: true, description: true, personality: true,
        scenario: true, first_mes: true, mes_example: true,
        alternate_greetings: false, authors_note: true,
        system_prompt: true, post_history_instructions: true, name: false,
    },
    completionSound: 'none',
    completionSoundVolume: 80,
    completionSoundOnlyWhenUnfocused: false,
    wobbleWindow: false,
    altGreetingIndices: [],
    chatEditAIEnabled: true,
    chatEditPrompt: '',
    lorebookExcludedBooks: [],
    pickerPreviewLines: 1,
    pickerPreviewLastLines: 0,
    imageAnalysisMode: 'direct',
    attachedFiles: [],
    memoryEnabled: true,
    memoryInject: true,
    memoryScope: 'global',
    memoryTag: 'memory-update',
    memoryNotify: true,
    memories: {},
    toolsEnabled: true,
    toolsThinking: false,
    toolsMaxRounds: 5,
    toolsProtocol: 'text',
    toolsEnabled_search_chat: true,
    toolsEnabled_search_lorebook: true,
    toolsEnabled_get_lorebooks: true,
    toolsEnabled_ask_user: true,
    toolsEnabled_get_char_info: true,
    toolsEnabled_get_chat_stats: true,
    toolsEnabled_get_recent_messages: true,
    toolsEnabled_read_url: true,
    toolsEnabled_search_web: true,
    toolsEnabled_todo_write: true,
    includeSummaryception: true,
    useAspectEvolutia: true,
    autoExpandMacros: false,
    includeHiddenMessages: false,
};
// Ключи с объектными/массивными значениями: при первом сидинге отдаём копию,
// чтобы последующие мутации settings не протекали в общий DEFAULT_SETTINGS.
const CLONED_DEFAULT_KEYS = new Set([
    'customTheme', 'profiles', 'profileBindings', 'sessions', 'lorebookSelectedBooks',
    'lorebookEntryOverrides', 'quickPrompts', 'quickPromptSets', 'promptPresets',
    'stats', 'starredMessages', 'charEditFields', 'altGreetingIndices',
    'attachedFiles', 'memories',
]);

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXT_NAME]) extensionSettings[EXT_NAME] = {};
    const s = extensionSettings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = CLONED_DEFAULT_KEYS.has(k) ? JSON.parse(JSON.stringify(v)) : v;
    }
    // v2.10.0+: launcherMode replaces the removed floating FAB setting.
    // Users who had the persistent floating icon get the floating launcher by default.
    if (s.launcherMode === undefined) {
        s.launcherMode = s.floatingIconPersistent ? 'floating' : 'bar';
    }
    return s;
}

export function saveSettings(opts = {}) {
    SillyTavern.getContext().saveSettingsDebounced();
    // quiet: для сохранений, которые не меняют ничего, влияющего на системный
    // промпт (статистика и т.п.) — не сбрасываем кэш промпта и не считаем diff.
    if (!opts.quiet) {
        _dbgDiffSettings();
        invalidateSystemPromptCache('saveSettings');
    }
}

// ─── ST Context Helpers ─────────────────────────────────────────────────────
export function getBindingKey() {
    const ctx = SillyTavern.getContext();
    let charId = 'global';
    if (ctx.characterId !== undefined && ctx.characterId !== null) {
        charId = String(ctx.characterId);
    } else if (typeof window.this_chid !== 'undefined' && window.this_chid !== null) {
        charId = String(window.this_chid);
    }

    let chatId = 'default';
    try {
        if (typeof window.chat_file_name === 'string' && window.chat_file_name) {
            chatId = String(window.chat_file_name);
        } else if (typeof ctx.getCurrentChatId === 'function') {
            const r = ctx.getCurrentChatId(); if (r) chatId = String(r);
        }
        
        if (chatId === 'default' || !chatId) {
            if (ctx.chatId) chatId = String(ctx.chatId);
            else if (typeof window.chat_id !== 'undefined' && window.chat_id !== null) chatId = String(window.chat_id);
        }
    } catch (_) {}
    
    return { charId, chatId };
}

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

// ─── Storage Subsystem ─────────────────────────────

let _inMemoryBucket = { activeSessionId: null, sessions: [] };
let _currentSessionFileId = null;
const _saveQueue = new Map();
// Эпоха инициализации bucket: CHAT_CHANGED может прийти повторно, пока прошлый
// init ещё await'ит файл — без guard'а два пересекающихся init'а перемешивают
// _currentSessionFileId/_inMemoryBucket (побеждает поздно завершившийся).
let _bucketInitEpoch = 0;

// Контракт хранилища: файл на диске существует ⟺ в нём есть контент.
// Автосозданная «Сессия 1» без сообщений файл не заслуживает — иначе каждое
// открытие чата плодит пустые copilot_sess_*.json, которые никто не чистит.
function bucketHasContent(bucket) {
    const s = bucket?.sessions || [];
    return s.length > 1 || s.some(x => x.messages?.length > 0 || (x.overrides && Object.keys(x.overrides).length > 0));
}
const _filesWithContent = new Set(); // file_id, записанные/прочитанные с контентом на этой странице

// tool-раунды пушат временные сообщения (_tcTemp) в живой bucket; они чистятся
// между раундами, но таймер сохранения может выстрелить посреди раунда.
// Не даём им попасть на диск: клонируем только затронутые сессии.
function _stripTempMessages(bucket) {
    if (!bucket?.sessions) return bucket;
    let dirty = false;
    for (const s of bucket.sessions) {
        if (s.messages?.some(m => m._tcTemp)) { dirty = true; break; }
    }
    if (!dirty) return bucket;
    return {
        ...bucket,
        sessions: bucket.sessions.map(s =>
            s.messages?.some(m => m._tcTemp)
                ? { ...s, messages: s.messages.filter(m => !m._tcTemp) }
                : s
        )
    };
}

export async function saveSessionFile(file_id, payload, useKeepalive = false) {
    if (payload && !_filesWithContent.has(file_id) && !bucketHasContent(payload.bucket)) return true;
    const ctx = SillyTavern.getContext();
    try {
        const jsonStr = JSON.stringify({ ...payload, bucket: _stripTempMessages(payload.bucket) });
        const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file_id, data: b64 }),
            keepalive: useKeepalive
        });
        if (res.ok) _filesWithContent.add(file_id);
        return res.ok;
    } catch (e) {
        _dbgAdd('STORAGE_WRITE_FAILED', { file_id, error: e.message });
        console.error(`[${EXT_DISPLAY}] saveSessionFile error:`, e);
        return false;
    }
}

export async function deleteSessionFile(file_id) {
    if (!file_id) return true;
    const pending = _saveQueue.get(file_id);
    if (pending) { clearTimeout(pending.timer); _saveQueue.delete(file_id); }
    _filesWithContent.delete(file_id);
    const ctx = SillyTavern.getContext();
    try {
        const res = await fetch('/api/files/delete', {
            method: 'POST',
            headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: `user/files/${file_id}` }),
        });
        if (res.ok || res.status === 404) return true;
        _dbgAdd('STORAGE_DELETE_FAILED', { file_id, status: res.status });
        return false;
    } catch (e) {
        _dbgAdd('STORAGE_DELETE_FAILED', { file_id, error: e.message });
        return false;
    }
}

window.addEventListener('beforeunload', () => {
    for (const [fileId, item] of _saveQueue.entries()) {
        clearTimeout(item.timer);
        saveSessionFile(fileId, item.payload, true);
    }
    // saveSettings() идёт через 1-сек дебаунс ST — без явного flush последнее
    // изменение настроек за секунду до закрытия вкладки теряется.
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.saveSettings === 'function') ctx.saveSettings();
        else if (typeof window.saveSettings === 'function') window.saveSettings();
    } catch (_) {}
});

function _decodeBase64Utf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
}

function _tryParseSessionPayload(text) {
    try { return JSON.parse(text); } catch (_) {}
    try { return JSON.parse(_decodeBase64Utf8(text)); } catch (_) {}
    try { return JSON.parse(_repairJSON(text)); } catch (_) {}
    try { return JSON.parse(_repairJSON(_decodeBase64Utf8(text))); } catch (_) {}
    return undefined;
}

// Битый файл не перезаписываем молча: копируем сырой текст рядом (.corrupt-бэкап),
// чтобы ручное восстановление оставалось возможным после того, как на его место
// будет записан чистый bucket.
async function _backupCorruptedFile(file_id, rawText) {
    try {
        const ctx = SillyTavern.getContext();
        const backupName = `copilot_corrupt_${Date.now()}_${file_id.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
        const b64 = btoa(unescape(encodeURIComponent(rawText)));
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: backupName, data: b64 }),
        });
        _dbgAdd('STORAGE_CORRUPT_BACKUP', { file_id, backupName, ok: res.ok, size: rawText.length });
        if (typeof toastr !== 'undefined') {
            toastr.warning(
                `Файл сессий «${file_id}» повреждён и не читается. Начата чистая сессия; исходное содержимое сохранено в «${backupName}».`,
                EXT_DISPLAY, { timeOut: 15000 });
        }
        return res.ok;
    } catch (e) {
        _dbgAdd('STORAGE_CORRUPT_BACKUP_FAILED', { file_id, error: e.message });
        return false;
    }
}

export async function loadSessionFile(file_id, { expectBucket = false } = {}) {
    try {
        const res = await fetch(`/user/files/${file_id}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const text = await res.text();
        const trimmed = text.trim();
        if (!trimmed) return null;

        if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
            _dbgAdd('STORAGE_LOAD_HTML_REDIRECT', { file_id });
            return null;
        }

        const parsed = _tryParseSessionPayload(trimmed);
        if (parsed === undefined) {
            await _backupCorruptedFile(file_id, trimmed);
            throw new Error('Unrecoverable payload after base64/repair fallback');
        }
        // Файл парсится, но это не bucket сессий: та же порча, просто валидный JSON.
        // Бэкапим так же, иначе следующая запись молча затрёт данные.
        if (expectBucket && !parsed?.bucket) {
            _dbgAdd('STORAGE_SHAPE_INVALID', { file_id, keys: Object.keys(parsed || {}) });
            await _backupCorruptedFile(file_id, trimmed);
            throw new Error('Payload parsed but has no sessions bucket');
        }
        return parsed;
    } catch (e) {
        _dbgAdd('STORAGE_LOAD_ERROR', { file_id, error: e.message });
        console.error(`[${EXT_DISPLAY}] loadSessionFile error:`, e);
        return false; 
    }
}

export async function initChatBucket({ forceReset = false } = {}) {
    const myEpoch = ++_bucketInitEpoch;
    const isStale = () => myEpoch !== _bucketInitEpoch;
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    const { charId, chatId } = getBindingKey();

    // Сменa чата/персонажа/ветки = полностью новые входы buildSystemContent.
    // Бампаем сразу, до любых ранних return'ов ниже, чтобы кэш гарантированно сбрасывался.
    invalidateSystemPromptCache('initChatBucket');

    if (forceReset) {
        const prevMeta = ctx.chatMetadata.st_copilot || null;
        const freshId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
        ctx.chatMetadata.st_copilot = { format: 'v4', file_id: freshId, chat_id: chatId };
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
        _currentSessionFileId = freshId;
        _inMemoryBucket = { activeSessionId: null, sessions: [] };
        await commitBucketChanges(true);
        _dbgAdd('SESSION_FORCE_RESET', { charId, chatId, prevFileId: prevMeta?.file_id || null, newFileId: freshId });
        return;
    }

    for (const [fileId, item] of _saveQueue.entries()) {
        clearTimeout(item.timer);
        _saveQueue.delete(fileId);
        saveSessionFile(fileId, item.payload);
    }

    let meta = ctx.chatMetadata.st_copilot;
    let targetFileId = null;
    let payload = null;

    if (meta && meta.file_id && meta.format === 'v4') {
        if (meta.chat_id === chatId) {
            targetFileId = meta.file_id;
            payload = await loadSessionFile(targetFileId, { expectBucket: true });
            if (isStale()) return;
        } else {
            _dbgAdd('STORAGE_CHAT_BRANCH_DETECTED', { oldChatId: meta.chat_id, newChatId: chatId });
            payload = await loadSessionFile(meta.file_id);
            if (isStale()) return;
            targetFileId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;

            if (payload && payload !== false) {
                await saveSessionFile(targetFileId, payload);
                if (isStale()) return;
            }

            ctx.chatMetadata.st_copilot = { format: 'v4', file_id: targetFileId, chat_id: chatId };
            if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
        }
    } else {
        targetFileId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
        _dbgAdd('STORAGE_MIGRATION_V4_INIT', { targetFileId });

        const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
        payload = await loadSessionFile(`copilot_sess_${safeChatId}.json`);
        if (isStale()) return;

        if (!payload && meta && meta.file_id && meta.format !== 'v4') {
            payload = await loadSessionFile(meta.file_id);
            if (isStale()) return;
        }

        if (!payload) {
            const s = getSettings();
            if (s.sessions && s.sessions[charId]) {
                if (s.sessions[charId][chatId] && s.sessions[charId][chatId].sessions?.length > 0) {
                    payload = { bucket: { ...s.sessions[charId][chatId] } };
                    delete s.sessions[charId][chatId]; saveSettings();
                } else if (s.sessions[charId]['unified'] && s.sessions[charId]['unified'].sessions?.length > 0) {
                    payload = { bucket: { ...s.sessions[charId]['unified'] } };
                    delete s.sessions[charId]['unified']; saveSettings();
                }
            }
        }

        ctx.chatMetadata.st_copilot = { format: 'v4', file_id: targetFileId, chat_id: chatId };
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    }

    if (isStale()) return;
    _currentSessionFileId = targetFileId;

    if (payload === false) {
        if (isStale()) return;
        _dbgAdd('STORAGE_LOAD_CORRUPTED_RECOVERY', { brokenFileId: targetFileId, charId, chatId });
        const recoveryFileId = `copilot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`;
        ctx.chatMetadata.st_copilot = { format: 'v4', file_id: recoveryFileId, chat_id: chatId, recoveredFrom: targetFileId };
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();

        targetFileId = recoveryFileId;
        _inMemoryBucket = { activeSessionId: null, sessions: [] };
        _currentSessionFileId = targetFileId;
        await commitBucketChanges(true);

        toastr.error('Файл сессии Copilot был повреждён и не подлежит восстановлению. Создано новое хранилище сессий для этого чата; повреждённый файл сохранён на диске для ручного восстановления.', EXT_DISPLAY, { timeOut: 15000 });
        return;
    }

    if (payload && payload.bucket) {
        _inMemoryBucket = payload.bucket;
        if (bucketHasContent(_inMemoryBucket)) _filesWithContent.add(targetFileId);
        _dbgAdd('STORAGE_BUCKET_LOADED', { charId, chatId, fileId: targetFileId, sessionCount: _inMemoryBucket.sessions?.length || 0 });
    } else {
        _inMemoryBucket = { activeSessionId: null, sessions: [] };
        _dbgAdd('STORAGE_BUCKET_EMPTY_INIT', { charId, chatId, fileId: targetFileId, hadPayload: !!payload });
    }
    
    if (!payload || meta?.format !== 'v4') {
        await commitBucketChanges(true);
    }
}

export async function commitBucketChanges(force = false) {
    const fileName = _currentSessionFileId;
    if (!fileName) return;

    const { chatId } = getBindingKey();
    // Без deep-clone: payload сериализуется в saveSessionFile в момент фактической
    // записи (force — сразу, очередь — через 1с), клон на каждый commit копировал
    // все сессии/сообщения/свайпы впустую (commit'ов до 6 за генерацию).
    const payloadToSave = {
        _version: 4,
        chat_id_reference: chatId,
        updated_at: Date.now(),
        bucket: _inMemoryBucket
    };

    if (force) {
        const existing = _saveQueue.get(fileName);
        if (existing) clearTimeout(existing.timer);
        _saveQueue.delete(fileName);

        const success = await saveSessionFile(fileName, payloadToSave);
        if (!success) _dbgAdd('STORAGE_WRITE_FAILED', { fileName });
        // force=true означает load/recovery: новое состояние сессии может изменить
        // срез истории и, как следствие, системный промпт — сбрасываем.
        invalidateSystemPromptCache('commitBucketChanges:force');
    } else {
        const existing = _saveQueue.get(fileName);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            _saveQueue.delete(fileName);
            saveSessionFile(fileName, payloadToSave);
        }, 1000);

        _saveQueue.set(fileName, { timer, payload: payloadToSave });
    }
}

export function saveSessionsToMetadata() {
    commitBucketChanges();
}

export function getChatBucket() {
    return _inMemoryBucket;
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

// ─── Macro Expansion Helper ────────────────────────────────────────────────

export function expandMacros(text) {
    if (!text) return text;
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.substituteParams === 'function') {
            return ctx.substituteParams(text);
        }
        if (typeof window.substituteParams === 'function') {
            return window.substituteParams(text, ctx.name1, ctx.name2);
        }
    } catch (e) {
        console.warn(`[${EXT_DISPLAY}] Macro expansion error:`, e);
    }
    try {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        const d = char?.data || {};
        const now = new Date();
        return text
            .replace(/\{\{user\}\}/gi, ctx.name1 || 'User')
            .replace(/\{\{char\}\}/gi, char?.name || ctx.name2 || 'Character')
            .replace(/\{\{time\}\}/gi, now.toLocaleTimeString())
            .replace(/\{\{date\}\}/gi, now.toLocaleDateString())
            .replace(/\{\{isodate\}\}/gi, now.toISOString().split('T')[0])
            .replace(/\{\{isotime\}\}/gi, now.toTimeString().slice(0, 5))
            .replace(/\{\{lastMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                return msgs?.[msgs.length - 1]?.mes || '';
            })
            .replace(/\{\{lastUserMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                if (!msgs) return '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].is_user) return msgs[i].mes || '';
                }
                return '';
            })
            .replace(/\{\{lastCharMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                if (!msgs) return '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (!msgs[i].is_user) return msgs[i].mes || '';
                }
                return '';
            })
            .replace(/\{\{description\}\}/gi, d.description || char?.description || '')
            .replace(/\{\{personality\}\}/gi, d.personality || char?.personality || '')
            .replace(/\{\{scenario\}\}/gi, d.scenario || char?.scenario || '');
    } catch (_) {
        return text;
    }
}

import { showCustomDialog, escHtml } from './utils/util-dom.js';

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

export function getSessionFavKey() {
    const { charId, chatId } = getBindingKey();
    return `${charId} ${chatId}`;
}

export function getStarredMessages() {
    const s = getSettings();
    const key = getSessionFavKey();
    if (!s.starredMessages[key]) s.starredMessages[key] = [];
    return s.starredMessages[key];
}

export function isMessageStarred(msgId) {
    return getStarredMessages().includes(msgId);
}

export function toggleStarMessage(msgId) {
    const s = getSettings();
    const key = getSessionFavKey();
    if (!s.starredMessages[key]) s.starredMessages[key] = [];
    const arr = s.starredMessages[key];
    const idx = arr.indexOf(msgId);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(msgId);
    saveSettings();
    return idx < 0; // true = now starred
}