// Phased stream-failure recovery decision (planStreamRecovery): transparent
// retry when nothing was streamed, continue-from-cut when a partial exists,
// give up on stop/stale/exhausted budget.
import { describe, it, expect } from 'vitest';

import { planStreamRecovery } from '../src/api.js';

const base = { resultNull: true, partialLen: 0, retriesLeft: 1, stopped: false, isCurrent: true };

describe('planStreamRecovery', () => {
    it('transparent retry when nothing was streamed', () => {
        expect(planStreamRecovery(base)).toBe('transparent');
    });

    it('continue-from-cut when a partial exists', () => {
        expect(planStreamRecovery({ ...base, partialLen: 25 })).toBe('continue');
    });

    it('gives up when the retry budget is exhausted', () => {
        expect(planStreamRecovery({ ...base, retriesLeft: 0 })).toBe('none');
        expect(planStreamRecovery({ ...base, partialLen: 25, retriesLeft: 0 })).toBe('none');
    });

    it('never retries after a user stop or a stale run', () => {
        expect(planStreamRecovery({ ...base, stopped: true })).toBe('none');
        expect(planStreamRecovery({ ...base, isCurrent: false })).toBe('none');
    });

    it('ignores non-failed results', () => {
        expect(planStreamRecovery({ ...base, resultNull: false })).toBe('none');
    });
});
