import { EXT_DISPLAY } from './constants.js';
import { _dbgAdd } from './utils/util-debug.js';
import { _repairJSON } from './utils/util-text.js';
import { invalidateSystemPromptCache } from './state.js';
import { getBindingKey, getSettings, saveSettings } from './session-settings.js';

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

const _retryScheduled = new Set();
const _warnedSaveFailed = new Set();

export async function saveSessionFile(file_id, payload, useKeepalive = false) {
    const attempt = async () => {
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
    };

    const ok = await attempt();
    if (ok) return true;

    // One delayed retry: payload.bucket is the live bucket object, so the retry
    // serializes current state rather than the moment of failure. A keepalive
    // (unload) save cannot outlive a timer — retry regular saves only.
    if (useKeepalive || _retryScheduled.has(file_id)) return false;
    _retryScheduled.add(file_id);
    setTimeout(async () => {
        _retryScheduled.delete(file_id);
        const retried = await attempt();
        if (!retried && typeof toastr !== 'undefined' && !_warnedSaveFailed.has(file_id)) {
            _warnedSaveFailed.add(file_id);
            toastr.warning('Не удалось сохранить сессии Copilot на сервер. Изменения держатся в памяти и могут потеряться при закрытии страницы.', EXT_DISPLAY, { timeOut: 12000 });
        }
    }, 5000);
    return false;
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

// Tab close/navigate almost always fires visibilitychange first, and regular
// fetches are not capped at the 64 KiB keepalive body limit — flush there;
// the beforeunload keepalive above stays as a fallback for small payloads.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const [fileId, item] of _saveQueue.entries()) {
        clearTimeout(item.timer);
        _saveQueue.delete(fileId);
        saveSessionFile(fileId, item.payload);
    }
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

// Контракт результата loadSessionFile:
//   payload object — файл прочитан и распарсен;
//   null           — файла нет (404) или он пуст;
//   false          — файл ЕСТЬ, но содержимое непарсится (порча; .corrupt-бэкап сделан).
// Транспортные сбои (сеть, 5xx, HTML вместо данных) бросают исключение, а не
// сворачиваются в false: recovery-ветка initChatBucket имеет право запускаться
// только на порчу, иначе один 502 навсегда заменяет хранилище сессий пустым файлом.
export async function loadSessionFile(file_id, { expectBucket = false } = {}) {
    let res;
    try {
        res = await fetch(`/user/files/${file_id}`);
    } catch (e) {
        _dbgAdd('STORAGE_LOAD_TRANSPORT', { file_id, error: e.message });
        throw new Error(`Session storage unreachable: ${e.message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
        _dbgAdd('STORAGE_LOAD_HTTP', { file_id, status: res.status });
        throw new Error(`Session storage HTTP ${res.status}`);
    }

    const text = await res.text();
    const trimmed = text.trim();
    if (!trimmed) return null;

    // HTML вместо JSON: редирект на логин или заглушка сервера. Поверх такого
    // ответа писать нельзя — приравниваем к транспортному сбою.
    if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE')) {
        _dbgAdd('STORAGE_LOAD_HTML_REDIRECT', { file_id });
        throw new Error('Session storage returned HTML instead of data');
    }

    const parsed = _tryParseSessionPayload(trimmed);
    if (parsed === undefined) {
        await _backupCorruptedFile(file_id, trimmed);
        _dbgAdd('STORAGE_LOAD_CORRUPT', { file_id });
        return false;
    }
    // Файл парсится, но это не bucket сессий: та же порча, просто валидный JSON.
    // Бэкапим так же, иначе следующая запись молча затрёт данные.
    if (expectBucket && !parsed?.bucket) {
        _dbgAdd('STORAGE_SHAPE_INVALID', { file_id, keys: Object.keys(parsed || {}) });
        await _backupCorruptedFile(file_id, trimmed);
        return false;
    }
    return parsed;
}

export async function initChatBucket({ forceReset = false } = {}) {
    const myEpoch = ++_bucketInitEpoch;
    const isStale = () => myEpoch !== _bucketInitEpoch;
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    const { charId, chatId } = getBindingKey();

    // Transport failure (network/5xx/HTML) must abort the whole init: treating it
    // as "no data" would overwrite an unread bucket, and as "corrupt" would swap
    // the store for an empty recovery file. Neither file id nor metadata may move.
    let transportError = null;
    const safeLoad = async (fileId, opts) => {
        try {
            return await loadSessionFile(fileId, opts);
        } catch (e) {
            transportError = transportError || e;
            return null;
        }
    };
    const abortIfTransport = () => {
        if (!transportError) return false;
        _dbgAdd('STORAGE_INIT_TRANSPORT_ABORT', { chatId, error: transportError.message });
        if (typeof toastr !== 'undefined') {
            toastr.warning('Хранилище сессий недоступно (сервер не ответил). Сессии не изменялись — повторите открытие чата, когда сервер ответит.', EXT_DISPLAY, { timeOut: 12000 });
        }
        return true;
    };

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

    // Await the flush: a fire-and-forget save races the load below when the same
    // file is re-inited within the debounce window, and the stale disk read then
    // gets adopted into memory and written back without the queued changes.
    for (const [fileId, item] of _saveQueue.entries()) {
        clearTimeout(item.timer);
        _saveQueue.delete(fileId);
        await saveSessionFile(fileId, item.payload);
    }

    let meta = ctx.chatMetadata.st_copilot;
    let targetFileId = null;
    let payload = null;

    if (meta && meta.file_id && meta.format === 'v4') {
        if (meta.chat_id === chatId) {
            targetFileId = meta.file_id;
            payload = await safeLoad(targetFileId, { expectBucket: true });
            if (abortIfTransport() || isStale()) return;
        } else {
            _dbgAdd('STORAGE_CHAT_BRANCH_DETECTED', { oldChatId: meta.chat_id, newChatId: chatId });
            payload = await safeLoad(meta.file_id);
            if (abortIfTransport() || isStale()) return;
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
        payload = await safeLoad(`copilot_sess_${safeChatId}.json`);
        if (abortIfTransport() || isStale()) return;

        if (!payload && meta && meta.file_id && meta.format !== 'v4') {
            payload = await safeLoad(meta.file_id);
            if (abortIfTransport() || isStale()) return;
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
