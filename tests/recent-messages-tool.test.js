// get_recent_messages must expose send_date: chat-edit proposals copy it into
// msg_date/msg_dates for the identity guard (see chat-edit-apply tests).
import { describe, it, expect } from 'vitest';
import { executeTool } from '../src/features/feature-tools-engine.js';

describe('get_recent_messages tool contract', () => {
    it('every message carries send_date from the native chat', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'm0', is_user: false, send_date: 'January 1, 2026 10:00am' },
            { mes: 'm1', is_user: true, send_date: 'January 2, 2026 11:00am' },
        ];
        const res = await executeTool('get_recent_messages', { count: 5 });
        expect(res.messages).toHaveLength(2);
        expect(res.messages[0].send_date).toBe('January 1, 2026 10:00am');
        expect(res.messages[1].send_date).toBe('January 2, 2026 11:00am');
        expect(res.note).toContain('send_date');
    });

    it('offset reads the middle of the chat by native index', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = Array.from({ length: 20 }, (_, i) => ({ mes: `m${i}`, is_user: i % 2 === 0 }));
        const res = await executeTool('get_recent_messages', { offset: 15, count: 1, from_end: false });
        expect(res.messages).toHaveLength(1);
        expect(res.messages[0].index).toBe(15);
        expect(res.messages[0].content).toBe('m15');
    });

    it('offset with from_end reads the tail starting after the offset', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = Array.from({ length: 10 }, (_, i) => ({ mes: `m${i}`, is_user: false }));
        const res = await executeTool('get_recent_messages', { offset: 7, count: 10, from_end: true });
        expect(res.messages.map(m => m.index)).toEqual([7, 8, 9]);
    });

    it('offset 0 or absent keeps default behavior', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = Array.from({ length: 5 }, (_, i) => ({ mes: `m${i}`, is_user: false }));
        const res = await executeTool('get_recent_messages', { count: 2, from_end: false });
        expect(res.messages.map(m => m.index)).toEqual([0, 1]);
    });
});
