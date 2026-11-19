// The persisted event log must survive F5 without relying on unload flushes:
// async IndexedDB writes at page-hide are best-effort, so every recorded event
// is written immediately, and events recorded while the lazy load is still in
// flight are captured by the unconditional post-load write. Load chatter
// (migration/empty-init/session-created) stays out — informative, not overloaded.
import { describe, it, expect, beforeEach } from 'vitest';

import { recordEvent, flushEventLog, _resetEventLog } from '../src/utils/util-eventlog.js';

const KEY = 'st_copilot_event_log_v1';
const store = {};

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    _resetEventLog();
    globalThis.localforage = {
        setItem: async (k, v) => { store[k] = v; },
        getItem: async (k) => store[k] ?? null,
    };
});

describe('event log persistence', () => {
    it('survives a hard reload: history revived, new events appended after it', async () => {
        // Page 1
        recordEvent('GEN_START', { tokensIn: 100 });
        recordEvent('GEN_DONE', { chars: 10 });
        await flushEventLog();
        // Page 2 (fresh module state) — records right after boot, load in flight
        _resetEventLog();
        recordEvent('TOOL_EXECUTED', { toolName: 'search_web' });
        await flushEventLog();
        const lines = store[KEY];
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain('GEN_START');
        expect(lines[1]).toContain('GEN_DONE');
        expect(lines[2]).toContain('TOOL_EXECUTED');
    });

    it('load chatter (migration/empty-init/session events) stays out', async () => {
        recordEvent('STORAGE_MIGRATION_V4_INIT', {});
        recordEvent('STORAGE_BUCKET_EMPTY_INIT', {});
        recordEvent('SESSION_CREATED', { id: 'x' }); // boot chatter — stays out
        recordEvent('GEN_START', {});
        await flushEventLog();
        const lines = store[KEY] || [];
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('GEN_START');
    });

    it('STORAGE_BUCKET_LOADED is kept — one line naming the active chat', async () => {
        recordEvent('STORAGE_BUCKET_LOADED', { chatId: 'c1', fileId: 'f1' });
        recordEvent('STORAGE_MIGRATION_V4_INIT', {});
        await flushEventLog();
        const lines = store[KEY] || [];
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('c1');
    });
});
