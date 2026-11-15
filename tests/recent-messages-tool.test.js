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
});
