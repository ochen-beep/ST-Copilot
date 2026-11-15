// The debug dump leaves the machine (users share it in bug reports), so API
// keys must never survive _dbgStrip — a real report leaked a live sk- key.
import { describe, it, expect } from 'vitest';
import { _dbgStrip } from '../src/utils/util-debug.js';
import { DBG_SKIP } from '../src/state.js';

describe('debug dump redaction', () => {
    it('customKey is stripped from settings snapshots', () => {
        const settings = { customKey: 'sk-live-secret-key', contextDepth: 3, enabled: true };
        const stripped = _dbgStrip(settings);
        expect(stripped.contextDepth).toBe(3);
        expect(stripped.enabled).toBe(true);
        expect(stripped.customKey).toBeUndefined();
        expect(JSON.stringify(stripped)).not.toContain('sk-live-secret-key');
    });

    it('profiles and sessions stay stripped (no key echo via profiles)', () => {
        const settings = {
            customKey: 'sk-live-secret-key',
            profiles: { 'Тест': { customKey: 'sk-profile-key' } },
            sessions: { sess_1: { messages: [{ role: 'user', content: 'hi' }] } },
        };
        const stripped = _dbgStrip(settings);
        expect(stripped.profiles).toBeUndefined();
        expect(stripped.sessions).toBeUndefined();
        expect(JSON.stringify(stripped)).not.toContain('sk-profile-key');
    });

    it('DBG_SKIP covers customKey', () => {
        expect(DBG_SKIP.has('customKey')).toBe(true);
    });
});
