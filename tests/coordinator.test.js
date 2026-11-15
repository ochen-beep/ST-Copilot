// The coordinator owns run staleness: a bug here resurrects zombie runs or
// wedges state.generating (the 2026-11-13 incident class). Strict tests.
import { describe, it, expect } from 'vitest';
import { createGenerationCoordinator } from '../src/utils/util-coordinator.js';

describe('createGenerationCoordinator', () => {
    it('beginRun makes the run current; endRun retires it', () => {
        const c = createGenerationCoordinator();
        const run = c.beginRun();
        expect(c.isCurrent(run)).toBe(true);
        expect(c.hasLiveRun()).toBe(true);
        expect(c.endRun(run)).toBe(true);
        expect(c.isCurrent(run)).toBe(false);
        expect(c.hasLiveRun()).toBe(false);
    });

    it('a new beginRun replaces the previous run (old run is not current)', () => {
        const c = createGenerationCoordinator();
        const a = c.beginRun();
        const b = c.beginRun();
        expect(c.isCurrent(a)).toBe(false);
        expect(c.isCurrent(b)).toBe(true);
        // A's late finally must not steal B's slot.
        expect(c.endRun(a)).toBe(false);
        expect(c.hasLiveRun()).toBe(true);
        expect(c.endRun(b)).toBe(true);
    });

    it('invalidateAll cancels the live run and ages out every older run', () => {
        const c = createGenerationCoordinator();
        const a = c.beginRun();
        c.invalidateAll();
        expect(c.isCurrent(a)).toBe(false);
        expect(c.hasLiveRun()).toBe(false);
        // A run begun BEFORE invalidateAll stays stale even after endRun/begin.
        expect(c.endRun(a)).toBe(false);
        const b = c.beginRun();
        expect(c.isCurrent(b)).toBe(true);
    });

    it('endRun is idempotent; isCurrent(null) is false', () => {
        const c = createGenerationCoordinator();
        const run = c.beginRun();
        expect(c.endRun(run)).toBe(true);
        expect(c.endRun(run)).toBe(false);
        expect(c.isCurrent(null)).toBe(false);
        expect(c.isCurrent(undefined)).toBe(false);
    });
});
