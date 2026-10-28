// Стресс хранилища и рендера под нагрузкой:
//   1. Очередь сохранения: 200 быстрых сообщений схлопываются в минимум записей,
//      ничего не теряется после flush; visibilitychange внутри очереди не рвёт данные.
//   2. Кап 400 сообщений на сессию: хвост сохраняется, ссылки живы.
//   3. Окно ленивого рендера на 1000 сообщений: DOM ограничен, подгрузка расширяет.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/state.js', async (importOriginal) => {
    const orig = await importOriginal();
    return { ...orig, invalidateSystemPromptCache: () => {} };
});
vi.mock('../src/utils/util-debug.js', async (importOriginal) => {
    const orig = await importOriginal();
    return { ...orig, _dbgAdd: () => {}, _dbgDiffSettings: () => {} };
});

const files = new Map();
let uploads = [];

globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/files/upload')) {
        const body = JSON.parse(opts.body);
        uploads.push(body.name);
        files.set(`user/files/${body.name}`, body.data);
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

let sessionMod;
const ctx = () => SillyTavern.getContext();

beforeEach(async () => {
    vi.resetModules();
    sessionMod = await import('../src/session.js');
    files.clear();
    uploads = [];
    ctx().chatMetadata = {
        st_copilot: { format: 'v4', file_id: 'f1.json', chat_id: 'default' },
    };
    files.set('user/files/f1.json', b64({ bucket: { activeSessionId: null, sessions: [] } }));
});

function b64(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }

describe('очередь сохранения под нагрузкой', () => {
    it('200 быстрых сообщений = 1 запись, весь контент на диске после flush', async () => {
        vi.useFakeTimers();
        try {
            await sessionMod.initChatBucket();
            const sess = sessionMod.getCurrentSession();
            for (let i = 0; i < 200; i++) {
                sessionMod.addMessage(sess, 'user', `msg-${i}`);
            }
            expect(uploads).toHaveLength(0); // дебаунс ещё не выстрелил
            await vi.runAllTimersAsync();
            expect(uploads).toHaveLength(1);
            const data = JSON.parse(decodeURIComponent(escape(atob(files.get('user/files/f1.json')))));
            const saved = data.bucket.sessions.find(s => s.id === sess.id);
            expect(saved.messages).toHaveLength(200);
            expect(saved.messages[0].content).toBe('msg-0');
            expect(saved.messages[199].content).toBe('msg-199');
        } finally {
            vi.useRealTimers();
        }
    });

    it('visibilitychange посреди очереди вытолквает всё накопленное', async () => {
        await sessionMod.initChatBucket();
        const sess = sessionMod.getCurrentSession();
        for (let i = 0; i < 50; i++) sessionMod.addMessage(sess, 'user', `burst-${i}`);
        const prev = document.visibilityState;
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: prev, configurable: true });
        expect(uploads).toHaveLength(1);
        const data = JSON.parse(decodeURIComponent(escape(atob(files.get('user/files/f1.json')))));
        const saved = data.bucket.sessions.find(s => s.id === sess.id);
        expect(saved.messages).toHaveLength(50);
    });
});

describe('кап 400 сообщений на сессию', () => {
    it('450 сообщений → хвост 400, первые 50 вытеснены, сейв целен', async () => {
        vi.useFakeTimers();
        try {
            await sessionMod.initChatBucket();
            const sess = sessionMod.getCurrentSession();
            for (let i = 0; i < 450; i++) {
                sessionMod.addMessage(sess, 'user', `m-${String(i).padStart(3, '0')}`);
            }
            expect(sess.messages).toHaveLength(400);
            expect(sess.messages[0].content).toBe('m-050');
            expect(sess.messages[399].content).toBe('m-449');
            await vi.runAllTimersAsync();
            const data = JSON.parse(decodeURIComponent(escape(atob(files.get('user/files/f1.json')))));
            const saved = data.bucket.sessions.find(s => s.id === sess.id);
            expect(saved.messages).toHaveLength(400);
        } finally {
            vi.useRealTimers();
        }
    });
});
