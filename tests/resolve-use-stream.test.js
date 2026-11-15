// resolveUseStream is the watchdog's source of truth for whether chunks will
// ever arrive: a regression here either starves the stall timer (hangs) or
// kills healthy non-streaming requests at the streaming cap.
import { describe, it, expect } from 'vitest';
import { resolveUseStream } from '../src/api.js';
import { toOpenAITools } from '../src/features/feature-tools-engine.js';

describe('resolveUseStream', () => {
    it('forceStreaming on/off wins over everything', () => {
        expect(resolveUseStream({ forceStreaming: 'on' }, false).useStream).toBe(true);
        expect(resolveUseStream({ forceStreaming: true }, false).useStream).toBe(true);
        expect(resolveUseStream({ forceStreaming: 'off' }, false).useStream).toBe(false);
    });

    it('auto resolves from the ST stream toggle (stub has none → default true)', () => {
        expect(resolveUseStream({}, false).useStream).toBe(true);
    });

    it('native tools force non-streaming when the tools payload is non-empty', () => {
        const hasTools = toOpenAITools().length > 0;
        const r = resolveUseStream({ forceStreaming: 'on' }, true);
        // tools availability depends on settings; the invariant must hold either way
        expect(r.useStream).toBe(hasTools ? false : true);
        expect(r.nativeTools).toBe(hasTools);
    });

    it('native tools with an empty tools payload degrade to plain non-native call', () => {
        const r = resolveUseStream({}, true);
        if (toOpenAITools().length === 0) {
            expect(r.nativeTools).toBe(false);
            expect(r.useStream).toBe(true);
        }
    });
});
