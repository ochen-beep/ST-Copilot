// Контракт отказоустойчивости хранилища сессий:
//   транспортный сбой (сеть/5xx) — init прерывается, ни одной записи, метаданные на месте;
//   порча payload — .corrupt-бэкап + recovery-файл (единственный сценарий замены хранилища);
//   404 — файл просто ещё не существует, пустой bucket не пишется.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/state.js', () => ({ invalidateSystemPromptCache: () => {} }));
vi.mock('../src/utils/util-debug.js', () => ({ _dbgAdd: () => {}, _dbgDiffSettings: () => {} }));

// Режим ответа GET /user/files/<id> на текущий тест.
let getMode = 'ok'; // 'ok' | 'fail500' | 'corrupt'
let uploadDelayMs = 0;
let uploadShouldFail = false;
const files = new Map();
let uploads = [];

function b64(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }

globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/files/upload')) {
        if (uploadDelayMs) await new Promise(r => setTimeout(r, uploadDelayMs));
        const body = JSON.parse(opts.body);
        uploads.push(body.name);
        if (uploadShouldFail) return { ok: false, status: 500 };
        files.set(`user/files/${body.name}`, body.data);
        return { ok: true, status: 200 };
    }
    if (u.startsWith('/user/files/')) {
        const path = u.replace(/^.*\/user\/files\//, 'user/files/');
        if (getMode === 'fail500') return { ok: false, status: 500, text: async () => '' };
        if (getMode === 'corrupt') return { ok: true, status: 200, text: async () => '|||||' };
        const data = files.get(path);
        if (data === undefined) return { ok: false, status: 404, text: async () => '' };
        return { ok: true, status: 200, text: async () => data };
    }
    return { ok: true, status: 200, text: async () => '' };
});

let sessionMod;
const ctx = () => SillyTavern.getContext();

beforeEach(async () => {
    vi.resetModules();
    sessionMod = await import('../src/session.js');
    getMode = 'ok';
    uploadDelayMs = 0;
    uploadShouldFail = false;
    files.clear();
    uploads = [];
    vi.mocked(globalThis.fetch).mockClear();
    ctx().chatMetadata = {
        st_copilot: { format: 'v4', file_id: 'f1.json', chat_id: 'default' },
    };
    files.set('user/files/f1.json', b64({
        bucket: { activeSessionId: 's1', sessions: [{ id: 's1', name: 'S', messages: [{ id: 'm1', role: 'user', content: 'hello' }] }] },
    }));
});

describe('транспортный сбой не рушит хранилище', () => {
    it('loadSessionFile бросает исключение на 5xx (не false)', async () => {
        getMode = 'fail500';
        await expect(sessionMod.loadSessionFile('f1.json')).rejects.toThrow(/HTTP 500/);
    });

    it('initChatBucket при 5xx: без записей, метаданные и bucket не тронуты', async () => {
        getMode = 'fail500';
        await sessionMod.initChatBucket();
        expect(uploads).toEqual([]);
        expect(ctx().chatMetadata.st_copilot.file_id).toBe('f1.json');
        // активная сессия из непрочитанного файла не подменяется пустой:
        expect(sessionMod.getChatBucket().sessions).toHaveLength(0);
    });

    it('после восстановления сервера init читает тот же файл без recovery', async () => {
        getMode = 'fail500';
        await sessionMod.initChatBucket();
        getMode = 'ok';
        await sessionMod.initChatBucket();
        const sess = sessionMod.getCurrentSession();
        expect(sess.messages.map(m => m.content)).toEqual(['hello']);
        // повторный init того же файла не плодит записей
        expect(uploads).toEqual([]);
    });
});

describe('порча payload — единственный путь к recovery', () => {
    it('loadSessionFile возвращает false и делает .corrupt-бэкап', async () => {
        getMode = 'corrupt';
        const res = await sessionMod.loadSessionFile('f1.json', { expectBucket: true });
        expect(res).toBe(false);
        expect(uploads.some(n => n.startsWith('copilot_corrupt_'))).toBe(true);
    });

    it('initChatBucket при порче уводит метаданные на recovery с recoveredFrom', async () => {
        getMode = 'corrupt';
        await sessionMod.initChatBucket();
        const meta = ctx().chatMetadata.st_copilot;
        expect(meta.file_id).not.toBe('f1.json');
        expect(meta.recoveredFrom).toBe('f1.json');
        expect(uploads.some(n => n.startsWith('copilot_corrupt_'))).toBe(true);
        // пустой recovery-bucket файл не пишет (контракт «нет контента — нет файла»)
        expect(uploads.filter(n => /^copilot_sess_/.test(n))).toHaveLength(0);
    });

    it('recovery-хранилище живое: первое сообщение пишется в новый файл', async () => {
        vi.useFakeTimers();
        try {
            getMode = 'corrupt';
            await sessionMod.initChatBucket();
            const before = ctx().chatMetadata.st_copilot.file_id;
            const sess = sessionMod.getCurrentSession();
            sessionMod.addMessage(sess, 'user', 'после recovery');
            await vi.runAllTimersAsync();
            const sessUploads = uploads.filter(n => /^copilot_sess_/.test(n));
            expect(sessUploads).toHaveLength(1);
            expect(sessUploads[0]).not.toBe('f1.json');
            expect(ctx().chatMetadata.st_copilot.file_id).toBe(before);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('404 — нормальное отсутствие файла', () => {
    it('пустой bucket не создаёт файл, метаданные не переписываются', async () => {
        files.clear(); // f1.json исчез
        await sessionMod.initChatBucket();
        expect(uploads).toEqual([]);
        expect(ctx().chatMetadata.st_copilot.file_id).toBe('f1.json');
    });
});

describe('надёжность записи', () => {
    it('initChatBucket дожидается отложенных записей до чтения файла', async () => {
        // Искусственная задержка upload делает гонку «неawait flush vs load»
        // детерминированной: без await в init чтение успевает прочитать старьё.
        uploadDelayMs = 60;
        await sessionMod.initChatBucket();
        const sess = sessionMod.getCurrentSession();
        sessionMod.addMessage(sess, 'user', 'queued');
        await sessionMod.initChatBucket(); // второй init в окне дебаунса
        const restored = sessionMod.getCurrentSession();
        expect(restored.messages.map(m => m.content)).toEqual(['hello', 'queued']);
    });

    it('visibilitychange hidden вытолкняет очередь немедленно', async () => {
        await sessionMod.initChatBucket();
        const sess = sessionMod.getCurrentSession();
        sessionMod.addMessage(sess, 'user', 'on-hide');
        const prev = document.visibilityState;
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: prev, configurable: true });
        expect(uploads.filter(n => n === 'f1.json')).toHaveLength(1);
    });

    it('провал сейва ретраится один раз и доезжает', async () => {
        vi.useFakeTimers();
        try {
            await sessionMod.initChatBucket();
            const sess = sessionMod.getCurrentSession();
            uploadShouldFail = true;
            sessionMod.addMessage(sess, 'user', 'retry-me');
            await vi.advanceTimersByTimeAsync(1100); // дебаунс + неудачная попытка
            expect(uploads.filter(n => n === 'f1.json')).toHaveLength(1);
            uploadShouldFail = false;
            await vi.advanceTimersByTimeAsync(5200); // ретрай через 5с
            expect(uploads.filter(n => n === 'f1.json')).toHaveLength(2);
            const data = JSON.parse(decodeURIComponent(escape(atob(files.get('user/files/f1.json')))));
            const active = data.bucket.sessions.find(s => s.id === sess.id);
            expect(active.messages.map(m => m.content)).toContain('retry-me');
        } finally {
            vi.useRealTimers();
        }
    });

    it('удаление контента перезаписывает существующий файл пустым bucket (tombstone)', async () => {
        vi.useFakeTimers();
        try {
            await sessionMod.initChatBucket(); // читает f1 с контентом
            const sess = sessionMod.getCurrentSession();
            sessionMod.deleteCurrentSession(); // удаляет сессию, автосоздаёт пустую
            await vi.runAllTimersAsync();
            const data = JSON.parse(decodeURIComponent(escape(atob(files.get('user/files/f1.json')))));
            expect(data.bucket.sessions.filter(s => s.messages?.length)).toHaveLength(0);
            await sessionMod.initChatBucket(); // «перезагрузка»
            const restored = sessionMod.getCurrentSession();
            expect(restored.messages ?? []).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
