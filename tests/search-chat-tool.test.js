// search_chat contract: honest 500-char preview by default, full:true mode with
// a 20000-char cap, 5-result default in full mode, and full implying content.
import { describe, it, expect, beforeEach } from 'vitest';

let engine;
const ctx = SillyTavern.getContext();

const bigMsg = 'A'.repeat(3000) + 'NEEDLE' + 'B'.repeat(3000);

beforeEach(async () => {
    engine = await import('../src/features/feature-tools-engine.js');
    ctx.extensionSettings['st_copilot'] = { toolsEnabled: true };
    ctx.chat = [
        { mes: 'short match one', is_user: true },
        { mes: bigMsg, is_user: false },
        { mes: 'no match here', is_user: true },
        { mes: 'match two', is_user: false },
        { mes: 'match three', is_user: true },
        { mes: 'match four', is_user: false },
        { mes: 'match five', is_user: true },
        { mes: 'match six', is_user: false },
    ];
});

describe('search_chat preview mode', () => {
    it('truncates long matches at 500 chars with an honest marker', async () => {
        const r = await engine.executeTool('search_chat', { queries: ['needle'] });
        expect(r.found).toBe(1);
        const c = r.results[0].content;
        expect(c).toHaveLength(500 + '...[truncated — 6006 chars total, pass full:true for complete text]'.length);
        expect(c).toContain('...[truncated — 6006 chars total, pass full:true for complete text]');
    });

    it('keeps short matches intact', async () => {
        const r = await engine.executeTool('search_chat', { queries: ['match two'] });
        expect(r.results[0].content).toBe('match two');
    });
});

describe('search_chat full mode', () => {
    it('full:true returns the complete untruncated text', async () => {
        const r = await engine.executeTool('search_chat', { queries: ['needle'], full: true });
        expect(r.results[0].content).toBe(bigMsg);
        expect(r.results[0].content).toContain('NEEDLE');
    });

    it('full:true defaults max_results to 5', async () => {
        const r = await engine.executeTool('search_chat', { queries: ['match'], full: true });
        expect(r.found).toBe(5);
        const preview = await engine.executeTool('search_chat', { queries: ['match'] });
        expect(preview.found).toBe(7);
    });

    it('full implies content even with include_content:false', async () => {
        const r = await engine.executeTool('search_chat', { queries: ['match two'], full: true, include_content: false });
        expect(r.results[0].content).toBe('match two');
    });

    it('full:true caps at 20000 chars with a marker', async () => {
        ctx.chat = [{ mes: 'x'.repeat(25000) + ' needle', is_user: false }];
        const r = await engine.executeTool('search_chat', { queries: ['needle'], full: true });
        expect(r.results[0].content).toHaveLength(20000 + '...[truncated — 25007 chars total]'.length);
        expect(r.results[0].content).toContain('...[truncated — 25007 chars total]');
    });
});
