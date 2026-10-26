// Контракт хранилища сессий: «файл на диске существует ⟺ в нём есть контент».
// Пустой бакет (автосессия без сообщений) файл не создаёт; опустошение
// существующего файла его перезаписывает; Clear удаляет файл, а не сиротит.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/state.js', () => ({ invalidateSystemPromptCache: () => {} }));
vi.mock('../src/utils/util-debug.js', () => ({ _dbgAdd: () => {}, _dbgDiffSettings: () => {} }));

import { initChatBucket, getCurrentSession, addMessage, deleteMsg, deleteSessionFile } from '../src/session.js';

// Файловая система-заглушка поверх fetch.
const files = new Map();       // 'user/files/<id>' -> b64
let uploads = [];              // имена загруженных файлов
let deletes = [];              // пути удалённых файлов

function b64(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
function unb64(s) { return JSON.parse(decodeURIComponent(escape(atob(s)))); }

globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/files/upload')) {
        const body = JSON.parse(opts.body);
        uploads.push(body.name);
        files.set(`user/files/${body.name}`, body.data);
        return { ok: true, status: 200 };
    }
    if (u.includes('/api/files/delete')) {
        const path = JSON.parse(opts.body).path;
        deletes.push(path);
        files.delete(path);
        return { ok: true, status: 200 };
    }
    if (u.startsWith('/user/files/')) {
        const path = u.replace(/^.*\/user\/files\//, 'user/files/');
        const data = files.get(path);
        if (data === undefined) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, text: async () => data };
    }
    return { ok: true, status: 200, text: async () => '' };
});

beforeEach(() => {
    vi.useFakeTimers();
    files.clear();
    uploads = [];
    deletes = [];
    const ctx = SillyTavern.getContext();
    ctx.chatMetadata = {};
});

afterEach(() => {
    vi.useRealTimers();
});

describe('контракт «нет контента — нет файла»', () => {
    it('свежий чат: initChatBucket + автосессия не пишут файл', async () => {
        await initChatBucket();
        getCurrentSession(); // автосоздание пустой «Сессия 1»
        getCurrentSession(); // и ещё раз — двойной commit пустого бакета
        expect(uploads).toEqual([]);
    });

    it('первое сообщение создаёт файл ровно один раз (force+debounce схлопываются)', async () => {
        await initChatBucket();
        const sess = getCurrentSession();
        addMessage(sess, 'user', 'привет');
        await vi.runAllTimersAsync(); // выстреливает debounce-очередь
        expect(uploads.length).toBe(1);
    });

    it('контент переживает перезагрузку страницы (initChatBucket читает файл)', async () => {
        await initChatBucket();
        const sess = getCurrentSession();
        addMessage(sess, 'user', 'привет');
        await vi.runAllTimersAsync();

        // «Перезагрузка»: новый init читает тот же файл по метаданным чата.
        await initChatBucket();
        const restored = getCurrentSession();
        expect(restored.messages.map(m => m.content)).toEqual(['привет']);
    });

    it('опустошение существующего файла перезаписывает его (контент не воскресает)', async () => {
        await initChatBucket();
        const sess = getCurrentSession();
        const msg = addMessage(sess, 'user', 'привет');
        await vi.runAllTimersAsync();
        const fileId = SillyTavern.getContext().chatMetadata.st_copilot.file_id;

        deleteMsg(sess, msg.id);
        await vi.runAllTimersAsync();

        const onDisk = unb64(files.get(`user/files/${fileId}`));
        expect(onDisk.bucket.sessions[0].messages).toEqual([]);
    });

    it('ветвление чата: контентный бакет копируется в новый файл', async () => {
        window.chat_file_name = 'chat_A';
        await initChatBucket();
        addMessage(getCurrentSession(), 'user', 'история A');
        await vi.runAllTimersAsync();
        const oldMeta = SillyTavern.getContext().chatMetadata.st_copilot;

        // Тот же персонаж, другой чат → ветка.
        window.chat_file_name = 'chat_B';
        await initChatBucket();
        const newMeta = SillyTavern.getContext().chatMetadata.st_copilot;

        expect(newMeta.file_id).not.toBe(oldMeta.file_id);
        expect(uploads).toContain(newMeta.file_id); // копия записана
        const copy = unb64(files.get(`user/files/${newMeta.file_id}`));
        expect(copy.bucket.sessions[0].messages[0].content).toBe('история A');
    });

    it('ветвление чата: пустой бакет НЕ копируется в новый файл', async () => {
        window.chat_file_name = 'chat_A';
        await initChatBucket();
        getCurrentSession(); // пустая автосессия — файла нет
        const oldMeta = SillyTavern.getContext().chatMetadata.st_copilot;
        expect(uploads).toEqual([]);

        window.chat_file_name = 'chat_B';
        await initChatBucket();
        const newMeta = SillyTavern.getContext().chatMetadata.st_copilot;
        expect(newMeta.file_id).not.toBe(oldMeta.file_id);
        expect(uploads).toEqual([]); // пустота не плодит файлов
    });
});

describe('deleteSessionFile (контракт Clear)', () => {
    it('удаляет файл с диска и отменяет отложенную запись (сироты не воскресают)', async () => {
        await initChatBucket();
        const sess = getCurrentSession();
        addMessage(sess, 'user', 'контент');
        await vi.runAllTimersAsync();
        const fileId = SillyTavern.getContext().chatMetadata.st_copilot.file_id;
        expect(files.has(`user/files/${fileId}`)).toBe(true);

        addMessage(sess, 'user', 'ещё');          // ставит debounce-запись в очередь
        await deleteSessionFile(fileId);          // Clear: удаление отменяет очередь
        await vi.runAllTimersAsync();

        expect(deletes).toEqual([`user/files/${fileId}`]);
        expect(files.has(`user/files/${fileId}`)).toBe(false);
        // Отложенная запись не выполнилась — файл не воскрес.
        expect(uploads.filter(n => n === fileId).length).toBe(1);
    });

    it('после Clear новый пустой бакет файл не создаёт', async () => {
        await initChatBucket();
        addMessage(getCurrentSession(), 'user', 'контент');
        await vi.runAllTimersAsync();
        const oldFileId = SillyTavern.getContext().chatMetadata.st_copilot.file_id;

        await initChatBucket({ forceReset: true });      // это делает кнопка Clear
        await deleteSessionFile(oldFileId);
        getCurrentSession();                              // новая автосессия

        const newFileId = SillyTavern.getContext().chatMetadata.st_copilot.file_id;
        expect(newFileId).not.toBe(oldFileId);
        expect(uploads).toEqual([oldFileId]);             // нового файла нет
    });
});
