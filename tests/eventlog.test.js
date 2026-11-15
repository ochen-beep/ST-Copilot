// The persisted event log is the F5-crossing diagnostic layer: if it breaks,
// interruption reports lose their evidence again. Keep these tests strict.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fresh module instance per test where needed: the log is module-scoped state,
// and the "survives F5" case is precisely a new instance reading old storage.
function makeStore() {
    const store = new Map();
    return {
        store,
        getItem: async k => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async k => { store.delete(k); },
    };
}

function installLocalforage(storeObj) {
    globalThis.SillyTavern.libs = { localforage: storeObj };
}

async function flushPersist() {
    // Debounce is a real 500 ms setTimeout — wait it out (no fake-timer dance
    // with the async load path; tests here are few).
    await new Promise(r => setTimeout(r, 650));
}

beforeEach(() => {
    delete globalThis.SillyTavern.libs;
    vi.resetModules();
});

describe('util-eventlog', () => {
    it('signal filter: GEN_*/TOOL_*/SESSION_*/STORAGE_* and error classes pass, noise families do not', async () => {
        const { isSignalEvent, recordEvent, dumpEventLog } = await import('../src/utils/util-eventlog.js');
        expect(isSignalEvent('GEN_DONE')).toBe(true);
        expect(isSignalEvent('TOOL_EXECUTION_FAILED')).toBe(true);
        expect(isSignalEvent('SESSION_DELETED')).toBe(true);
        expect(isSignalEvent('STORAGE_WRITE_FAILED')).toBe(true);
        expect(isSignalEvent('WINDOW_ERROR')).toBe(true);
        expect(isSignalEvent('UI_ERROR_POPUP')).toBe(true);
        // Noise: excluded by design (they live in the volatile debug ring).
        expect(isSignalEvent('LB_PROPOSAL_CARD_RENDER')).toBe(false);
        expect(isSignalEvent('MEM_ADDED')).toBe(false);
        expect(isSignalEvent('PICKER_CLOSE')).toBe(false);
        expect(isSignalEvent('TEXT_REPLACE_FAILED')).toBe(false);
        expect(isSignalEvent('SETTINGS_CHANGED')).toBe(false);
        recordEvent('GEN_DONE', { chars: 5 });
        recordEvent('LB_PROPOSAL_CARD_RENDER', { msgId: 'x' });
        const dump = dumpEventLog();
        expect(dump).toContain('GEN_DONE');
        expect(dump).not.toContain('LB_PROPOSAL');
    });

    it('ring caps at 150 events', async () => {
        const { recordEvent, dumpEventLog } = await import('../src/utils/util-eventlog.js');
        for (let i = 0; i < 200; i++) recordEvent('GEN_DONE', { i });
        const lines = dumpEventLog().split('\n');
        expect(lines.length).toBe(150);
        expect(lines[0]).toContain('"i":50');
        expect(lines[149]).toContain('"i":199');
    });

    it('payload is truncated in the stored line', async () => {
        const { recordEvent, dumpEventLog } = await import('../src/utils/util-eventlog.js');
        recordEvent('GEN_ERROR', { msg: 'x'.repeat(1000) });
        const line = dumpEventLog();
        expect(line.length).toBeLessThan(300);
        expect(line.endsWith('…')).toBe(true);
    });

    it('persists debounced and a fresh instance merges history before session events (F5)', async () => {
        const storeObj = makeStore();
        installLocalforage(storeObj);
        const first = await import('../src/utils/util-eventlog.js');
        first.recordEvent('GEN_DONE', { tag: 'before-reload' });
        await flushPersist();
        expect(storeObj.store.has('st_copilot_event_log_v1')).toBe(true);

        vi.resetModules();
        const second = await import('../src/utils/util-eventlog.js');
        second.recordEvent('GEN_START', { tag: 'after-reload' });
        await flushPersist();

        const raw = storeObj.store.get('st_copilot_event_log_v1');
        expect(Array.isArray(raw)).toBe(true);
        const beforeIdx = raw.findIndex(l => l.includes('before-reload'));
        const afterIdx = raw.findIndex(l => l.includes('after-reload'));
        expect(beforeIdx).toBeGreaterThanOrEqual(0);
        expect(afterIdx).toBeGreaterThan(beforeIdx); // chronological across F5
    });

    it('flushEventLog writes immediately without waiting for the debounce', async () => {
        const storeObj = makeStore();
        installLocalforage(storeObj);
        const { recordEvent, flushEventLog } = await import('../src/utils/util-eventlog.js');
        recordEvent('GEN_ERROR', { msg: 'boom' });
        await flushEventLog();
        expect(storeObj.store.get('st_copilot_event_log_v1').some(l => l.includes('boom'))).toBe(true);
    });

    it('localforage failure degrades to memory-only, no throw', async () => {
        installLocalforage({
            getItem: async () => { throw new Error('disk gone'); },
            setItem: async () => { throw new Error('disk gone'); },
        });
        const { recordEvent, dumpEventLog, flushEventLog } = await import('../src/utils/util-eventlog.js');
        expect(() => recordEvent('GEN_DONE', {})).not.toThrow();
        await expect(flushEventLog()).resolves.toBeUndefined();
        expect(dumpEventLog()).toContain('GEN_DONE');
    });

    it('_dbgAdd hook feeds the event log for signal types only', async () => {
        const storeObj = makeStore();
        installLocalforage(storeObj);
        const { _dbgAdd } = await import('../src/utils/util-debug.js');
        const { dumpEventLog } = await import('../src/utils/util-eventlog.js');
        _dbgAdd('GEN_DONE', { chars: 10 });
        _dbgAdd('PICKER_CLOSE', {});
        await flushPersist();
        const dump = dumpEventLog();
        expect(dump).toContain('GEN_DONE');
        expect(dump).not.toContain('PICKER_CLOSE');
        expect(storeObj.store.get('st_copilot_event_log_v1').some(l => l.includes('GEN_DONE'))).toBe(true);
    });
});
