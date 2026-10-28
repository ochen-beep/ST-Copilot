// Таймауты генерации: ask_user — таймаут и прерывание через generationStopped
// (Stop / смена чата). Конфиг таймаутов инъектируется через _genTimeouts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { awaitAskUserAnswer, _genTimeouts } from '../src/api.js';
import { state } from '../src/state.js';

const never = () => new Promise(() => {});

beforeEach(() => {
    state.generationStopped = false;
    _genTimeouts.askUserMs = 300000;
    _genTimeouts.stallMs = 180000;
});

describe('awaitAskUserAnswer', () => {
    it('таймаут возвращает __ask_timeout (сжатый конфиг вместо 5 минут)', async () => {
        vi.useFakeTimers();
        try {
            _genTimeouts.askUserMs = 1000;
            const p = awaitAskUserAnswer(never());
            const r = await vi.advanceTimersByTimeAsync(1001);
            void r;
            const result = await p;
            expect(result.__ask_timeout).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('generationStopped=true прерывает ожидание раньше таймаута', async () => {
        vi.useFakeTimers();
        try {
            _genTimeouts.askUserMs = 60000;
            const p = awaitAskUserAnswer(never());
            await vi.advanceTimersByTimeAsync(600); // первый опрос 500мс
            state.generationStopped = true;
            await vi.advanceTimersByTimeAsync(600);
            const result = await p;
            expect(result.__ask_cancelled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('ответ пользователя резолвится как есть', async () => {
        let resolve;
        const p = awaitAskUserAnswer(new Promise(r => { resolve = r; }));
        resolve('текст пользователя');
        const result = await p;
        expect(result).toBe('текст пользователя');
    });
});
