// Ownership of the single generation run.
//
// Copilot runs ONE generation at a time (global slot), unlike Diegetic's
// per-message slots: per-message revisions have no consumer here because the
// UI guards already block message edit/delete while a run is live.
//
//   - beginRun/endRun: the run lifecycle. endRun only clears the slot the run
//     still owns, so a zombie run's finally (e.g. after a chat switch) can
//     never clobber the flags of a newer run — the 2026-11-13 incident class
//     (stuck state.generating until reload).
//   - isCurrent: the single staleness predicate, checked after every await
//     and right before any commit/tool-execution.
//   - invalidateAll: chat switch / shutdown — bumps the epoch and cancels the
//     live run; every older run's isCurrent() goes false.

export function createGenerationCoordinator() {
    let epoch = 0;
    let current = null;
    let tokenSeq = 0;

    function beginRun() {
        const run = { token: ++tokenSeq, epoch, canceled: false };
        current = run;
        return run;
    }

    function isCurrent(run) {
        return !!run && current === run && !run.canceled && run.epoch === epoch;
    }

    function endRun(run) {
        if (!isCurrent(run)) return false;
        current = null;
        return true;
    }

    function invalidateAll() {
        epoch++;
        if (current) current.canceled = true;
        current = null;
    }

    function hasLiveRun() {
        return !!current;
    }

    return { beginRun, isCurrent, endRun, invalidateAll, hasLiveRun };
}

// Single shared instance: generation ownership is process-wide.
export const genCoord = createGenerationCoordinator();
