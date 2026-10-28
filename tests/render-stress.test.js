// Окно ленивого рендера на 1000 сообщениях: DOM ограничен, подгрузка расширяет.
// Без vi.mock — моки ломают SSR-материализацию фасадных биндингов (класс бага
// widget-inspector); чистый граф как в launcher-smoke.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { initChatBucket, addMessage, getCurrentSession, saveSessionsToMetadata } from '../src/session.js';

const files = new Map();

globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/files/upload')) {
        const body = JSON.parse(opts.body);
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

function b64(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }

beforeEach(async () => {
    files.clear();
    SillyTavern.getContext().chatMetadata = {
        st_copilot: { format: 'v4', file_id: 'f1.json', chat_id: 'default' },
    };
    files.set('user/files/f1.json', b64({ bucket: { activeSessionId: null, sessions: [] } }));
});

describe('окно ленивого рендера на 1000 сообщений', () => {
    it('renderSession ограничивает DOM 80+кнопкой, loadOlder расширяет', async () => {
        vi.useFakeTimers();
        try {
            await initChatBucket();
            const sess = getCurrentSession();
            for (let i = 0; i < 1000; i++) addMessage(sess, 'user', `bulk-${i}`);
            await vi.runAllTimersAsync();
        } finally {
            vi.useRealTimers();
        }

        document.body.innerHTML = '<div id="scp-messages"></div>';
        const { renderSession, updateMsgCount } = await import('../src/ui/ui-chat.js');
        const sess = getCurrentSession();
        renderSession(sess);
        const container = document.getElementById('scp-messages');
        const msgEls = container.querySelectorAll('.scp-msg');
        expect(msgEls.length).toBeLessThanOrEqual(81); // окно 80 + возможный частичный
        // видимое окно — это ХВОСТ сессии
        expect(msgEls[0].textContent).toContain('bulk-9');
        expect(msgEls[msgEls.length - 1].textContent).toContain('bulk-999');

        // подгрузка старых: окно сдвигается, DOM растёт, данные те же
        const loadOlder = container.querySelector('.scp-load-older-btn');
        expect(loadOlder).toBeTruthy();
        loadOlder.click();
        const msgEls2 = container.querySelectorAll('.scp-msg');
        expect(msgEls2.length).toBeGreaterThan(msgEls.length);
        expect(msgEls2[0].textContent).not.toContain('bulk-9');
    });

    it('счётчик отражает кап: после 1000 add в сессии 400 (cap addMessage)', async () => {
        document.body.innerHTML = '<div id="scp-messages"></div><div id="scp-msg-count"></div>';
        const { renderSession, updateMsgCount } = await import('../src/ui/ui-chat.js');
        const sess = getCurrentSession();
        for (let i = 0; i < 1000; i++) addMessage(sess, 'user', `bulk-${i}`);
        renderSession(sess);
        updateMsgCount(sess);
        const el = document.getElementById('scp-msg-count');
        expect(el.textContent).toContain('400');
    });
});
