// Tests for the system-prompt cache dirty-flag decision logic.
// Pure logic: nothing from ST or DOM is required.
import { describe, it, expect, beforeEach } from 'vitest';
import { decideSystemPromptCache, invalidateSystemPromptCache } from '../src/state.js';
// Импортируем тот же самый shared state-объект, что и app code, чтобы
// инвалидация реактивно отражалась на decide-тестах.
import { state as liveState } from '../src/state.js';

function snapshot(over = {}) {
    // Локальный стенд для теста decide — изолирован от shared state.
    return {
        systemPromptDirty: false,
        systemPromptCache: 'cached-promise-placeholder',
        systemPromptSig: 'aa11bb22',
        systemPromptEpoch: 0,
        ...over,
    };
}

describe('decideSystemPromptCache', () => {
    it('returns hit when signature matches and cache present and not dirty', () => {
        const st = snapshot({ systemPromptSig: 'aa11bb22' });
        const d = decideSystemPromptCache(st, 'aa11bb22');
        expect(d.useCache).toBe(true);
        expect(d.reason).toBe('hit');
    });

    it('returns miss (dirty-flag) when dirty even if sig matches', () => {
        const st = snapshot({ systemPromptDirty: true, systemPromptSig: 'aa11bb22' });
        const d = decideSystemPromptCache(st, 'aa11bb22');
        expect(d.useCache).toBe(false);
        expect(d.reason).toBe('dirty-flag');
    });

    it('returns miss (cache-empty) when dirty cleared but cache null', () => {
        const st = snapshot({ systemPromptDirty: false, systemPromptCache: null, systemPromptSig: 'aa11bb22' });
        const d = decideSystemPromptCache(st, 'aa11bb22');
        expect(d.useCache).toBe(false);
        expect(d.reason).toBe('cache-empty');
    });

    it('returns miss (sig-mismatch) when signature between calls changed', () => {
        // Покрывает редкий кейс: изменили systemPrompt в настройках, а invalidate
        // по какой-то причине не позвали — подпись ловит расхождение.
        const st = snapshot({ systemPromptDirty: false, systemPromptSig: 'aa11bb22' });
        const d = decideSystemPromptCache(st, 'ff00ffee');
        expect(d.useCache).toBe(false);
        expect(d.reason).toBe('sig-mismatch');
    });

    it('dirty-flag takes precedence over cache-empty', () => {
        const st = snapshot({ systemPromptDirty: true, systemPromptCache: null });
        const d = decideSystemPromptCache(st, 'whatever');
        expect(d.useCache).toBe(false);
        expect(d.reason).toBe('dirty-flag');
    });
});

describe('invalidateSystemPromptCache', () => {
    beforeEach(() => {
        // Гарантируем датское стартовое состояние перед каждым тестом:
        // dirty=true, cache/sig=null, epoch=0. Так тесты изолированы друг от друга.
        // (preserveSystemPromptCache сам guarding'а нет — мы держим invariant руками.)
        liveState.systemPromptDirty = true;
        liveState.systemPromptCache = null;
        liveState.systemPromptSig = null;
        liveState.systemPromptEpoch = 0;
        liveState.systemPromptInvalidateReason = 'init';
    });

    it('raises dirty flag, clears cache+sig, advances epoch by 1', () => {
        // Arrange: представим, что кэш был валиден (hit-состояние).
        liveState.systemPromptDirty = false;
        liveState.systemPromptCache = Promise.resolve('cached-text');
        liveState.systemPromptSig = 'abcd1234';
        liveState.systemPromptEpoch = 7;

        invalidateSystemPromptCache('saveSettings');

        expect(liveState.systemPromptDirty).toBe(true);
        expect(liveState.systemPromptCache).toBeNull();
        expect(liveState.systemPromptSig).toBeNull();
        expect(liveState.systemPromptEpoch).toBe(8);
        expect(liveState.systemPromptInvalidateReason).toBe('saveSettings');
    });

    it('is idempotent-safe: two consecutive invalidates still leave cache null + dirty', () => {
        invalidateSystemPromptCache('first');
        const epochAfterFirst = liveState.systemPromptEpoch;
        expect(epochAfterFirst).toBe(1);
        invalidateSystemPromptCache('second');
        expect(liveState.systemPromptDirty).toBe(true);
        expect(liveState.systemPromptCache).toBeNull();
        expect(liveState.systemPromptSig).toBeNull();
        expect(liveState.systemPromptEpoch).toBe(2);
        expect(liveState.systemPromptInvalidateReason).toBe('second');
    });

    it('after invalidate, decide returns dirty-flag miss (no hit possible)', () => {
        // Arrange: had cache, hit-state.
        liveState.systemPromptDirty = false;
        liveState.systemPromptCache = Promise.resolve('x');
        liveState.systemPromptSig = 'xyz';

        invalidateSystemPromptCache('WORLDINFO_UPDATED');

        const d = decideSystemPromptCache(liveState, 'xyz');
        expect(d.useCache).toBe(false);
        expect(d.reason).toBe('dirty-flag');
    });
});