// Persisted event log: a signal-only ring that survives F5 — unlike the
// DBG_STATE ring (in-memory, floods within minutes on noisy paths; the
// 2026-11-15 dump arrived with every TOOL_*/GEN_* event evicted by a
// TEXT_REPLACE flood). Kept deliberately tiny: one line per significant
// transition, best effort everywhere.
//
// Persistence is IMMEDIATE on every recorded event, with no debounce: async
// IndexedDB writes issued at page-hide are best-effort and may not complete
// (web.dev page-lifecycle guidance) — the 2026-11-16 dump lost its whole
// generation tail that way. The ring is low-frequency, so a write per event
// costs nothing and unload flushes become pure redundancy.
//
// Store: SillyTavern.libs.localforage, provided by ST core (public/lib.js
// sets window.localforage / SillyTavern.libs) — nothing to bundle. Read or
// write failures degrade to the in-memory ring and never break callers.

const MAX_EVENTS = 150;
const MAX_PAYLOAD_CHARS = 240;
const LF_KEY = 'st_copilot_event_log_v1';

// Signal allowlist: rare, significant transitions only. Deliberately excludes
// the noisy families (LB_*/MEM_*/SEARCH_*/PICKER_*/CHAR_*/PROFILE_*/SWIPE_*/
// TEXT_REPLACE_*/SETTINGS_*) and the per-reload boot chatter (SESSION_CREATED/
// STORAGE_MIGRATION_V4_INIT/STORAGE_BUCKET_EMPTY_INIT fire on every page load).
// Storage/session failures stay in: they are rare and explain data loss.
const SIGNAL_PREFIXES = ['GEN_', 'TOOL_'];
// Apply outcomes live under excluded prefixes (LB_*/CHAR_*) but are rare,
// user-action results — kept explicitly, like the session/storage transitions.
const SIGNAL_TYPES = new Set([
    'LB_APPLY_DONE',
    'CHAR_APPLY_DONE',
    'CHATEDIT_APPLIED',
    'SESSION_SWITCHED',
    'SESSION_DELETED',
    'SESSION_RENAMED',
    'STORAGE_BUCKET_LOADED',
    'STORAGE_WRITE_FAILED',
    'STORAGE_DELETE_FAILED',
    'STORAGE_SHAPE_INVALID',
    'SESSION_CLEAR_REQUESTED',
    'SESSION_CLEAR_DONE',
    'SESSION_CLEAR_FAILED',
    'WINDOW_ERROR',
    'UNHANDLED_REJECTION',
    'CONSOLE_ERROR',
    'UI_ERROR_POPUP',
    'UI_WARNING_POPUP',
]);

export function isSignalEvent(type) {
    if (SIGNAL_TYPES.has(type)) return true;
    return SIGNAL_PREFIXES.some(p => type.startsWith(p));
}

const _events = [];
let _loaded = false;
let _loadStarted = false;
let _loadPromise = null;
let _inFlight = null;

function _lf() {
    return globalThis.SillyTavern?.libs?.localforage ?? globalThis.localforage ?? null;
}

function _line(type, payload, ts) {
    let body = '';
    try { body = payload === undefined ? '' : JSON.stringify(payload); } catch (_) { body = String(payload); }
    if (body.length > MAX_PAYLOAD_CHARS) body = body.slice(0, MAX_PAYLOAD_CHARS) + '…';
    return `${new Date(ts).toISOString()} ${type} ${body}`;
}

function _persistNow() {
    try {
        const p = _lf()?.setItem(LF_KEY, _events.slice());
        _inFlight = p?.catch?.(() => {}) ?? null;
    } catch (_) { /* store unavailable — memory only */ }
}

// Lazy load on the first recorded event: no init-order wiring needed. Persisted
// history is prepended in front of anything already recorded this session, so
// the timeline reads chronologically across the F5 boundary.
function _ensureLoaded() {
    if (_loadStarted) return _loadPromise ?? Promise.resolve();
    _loadStarted = true;
    const lf = _lf();
    if (!lf) { _loaded = true; _loadPromise = Promise.resolve(); return _loadPromise; }
    _loadPromise = (async () => {
        let raw = null;
        try { raw = await lf.getItem(LF_KEY); } catch (_) { raw = null; }
        if (Array.isArray(raw)) {
            const revived = raw.filter(x => typeof x === 'string');
            const room = Math.max(0, MAX_EVENTS - _events.length);
            _events.unshift(...revived.slice(Math.max(0, revived.length - room)));
        }
        _loaded = true;
        // Unconditional: events recorded while the load was in flight lived
        // only in memory until now — this write captures them together with
        // the revived history. Without it a page dying inside the load window
        // loses its first events (the 2026-11-16 generation-tail loss).
        _persistNow();
    })();
    return _loadPromise;
}

export function recordEvent(type, payload, ts = Date.now()) {
    try {
        if (!isSignalEvent(type)) return;
        _events.push(_line(type, payload, ts));
        while (_events.length > MAX_EVENTS) _events.shift();
        _ensureLoaded();
        if (_loaded) _persistNow();
    } catch (_) { /* never break the caller */ }
}

// Best-effort write for page-hide paths (visibilitychange/pagehide below) —
// redundant with immediate persistence, kept so an in-flight write is awaited
// rather than dropped mid-transaction.
export function flushEventLog() {
    try {
        if (!_loadStarted) return Promise.resolve();
        const write = () => {
            const p = _lf()?.setItem(LF_KEY, _events.slice());
            _inFlight = p?.catch?.(() => {}) ?? null;
            return _inFlight ?? Promise.resolve();
        };
        return _loaded ? write() : _loadPromise.then(write);
    } catch (_) { return Promise.resolve(); }
}

// Newline-joined section body for the debug dump.
export function dumpEventLog() {
    return _events.length ? _events.join('\n') : '(no events recorded)';
}

// Test-only: drop in-memory state between cases.
export function _resetEventLog() {
    _inFlight = null;
    _events.length = 0;
    _loaded = false;
    _loadStarted = false;
    _loadPromise = null;
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushEventLog(); });
}
if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', () => { flushEventLog(); });
}
