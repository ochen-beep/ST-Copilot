// classifyToolError feeds the model a short, honest summary instead of a raw
// stack; the kind must never turn an unprovable failure (network/abort) into
// "the tool is broken".
import { describe, it, expect } from 'vitest';
import { classifyToolError } from '../src/features/feature-tools-engine.js';

describe('classifyToolError', () => {
    it('abort / user stop', () => {
        const ab = new Error('The user stopped generation');
        ab.name = 'AbortError';
        expect(classifyToolError(ab)).toMatchObject({ kind: 'stopped' });
        expect(classifyToolError(new Error('Generation stopped by user.'))).toMatchObject({ kind: 'stopped' });
    });

    it('withTimeout message → timeout', () => {
        const r = classifyToolError(new Error('Tool did not respond within 60s'));
        expect(r.kind).toBe('timeout');
        expect(r.userMessage).toContain('unknown');
    });

    it('fetch TypeError → network-unknown (never "tool broken")', () => {
        const r = classifyToolError(new TypeError('Failed to fetch'));
        expect(r.kind).toBe('network-unknown');
        expect(r.userMessage).toContain('not a tool failure');
    });

    it('provider HTTP status → provider-error with the code', () => {
        expect(classifyToolError(new Error('Custom API Error 500: {"error":{}}'))).toMatchObject({ kind: 'provider-error' });
        const r = classifyToolError(new Error('API Error 429: rate limited'));
        expect(r.kind).toBe('provider-error');
        expect(r.userMessage).toContain('429');
    });

    it('JSON parse → parse', () => {
        expect(classifyToolError(new SyntaxError('Unexpected token } in JSON'))).toMatchObject({ kind: 'parse' });
    });

    it('everything else → unknown with truncated message', () => {
        const r = classifyToolError(new Error('x'.repeat(500)));
        expect(r.kind).toBe('unknown');
        expect(r.userMessage.length).toBeLessThanOrEqual(200);
    });
});
