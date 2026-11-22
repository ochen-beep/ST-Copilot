// Long-press text selection for touch devices.
//
// Touch CSS keeps `user-select: none` on the whole feed (02-messages.css,
// `pointer: coarse`) so a slow drag always scrolls instead of selecting.
// This arbitration opts a single message in after a stationary hold:
// seeds a word-level selection at the touch point and keeps the gesture
// from turning into a pan via a temporary non-passive touchmove. Moving
// the finger before the hold fires cancels everything — scroll wins.

import { state } from '../state.js';

const HOLD_MS = 400;
const SLOP_PX = 10;

// Targets with their own gestures: buttons/actions, horizontally scrollable
// code, html-widget iframes, tool-card headers and proposal cards.
const SKIP_SEL = 'button, a, textarea, input, select, summary, '
    + '.scp-msg-actions, .scp-swipe-bar, '
    + '.scp-code-block-wrap, .scp-html-block, .scp-msg-att-badge, '
    + '.scp-tool-call-header, .scp-tc-group-header, '
    + '.scp-lb-proposal-card, .scp-char-proposal-card, '
    + '.scp-char-creation-card, .scp-chat-proposal-card, .scp-msg-hist-wrap';

// Gesture state: { msgEl, x, y, id, timer, activated }. Non-null only while
// a touch is down; the non-passive touchmove/touchend listeners below live
// exactly as long as `armed` does, so normal scrolling stays compositor-side.
let armed = null;
let feed = null;

export function setupTouchTextSelection() {
    feed = document.getElementById('scp-messages');
    if (!feed || feed.dataset.scpTouchSelectBound) return;
    feed.dataset.scpTouchSelectBound = '1';

    feed.addEventListener('touchstart', onTouchStart, { passive: true });
    // Android fires contextmenu mid-hold; suppress it only while a hold is
    // armed. Once a message is in selecting mode its native menu works.
    feed.addEventListener('contextmenu', (e) => {
        if (armed) e.preventDefault();
    });
}

function onTouchStart(e) {
    const selecting = feed.querySelector('.scp-msg.scp-selecting');
    if (selecting && !(e.target instanceof Element && selecting.contains(e.target))) {
        exitSelectMode(selecting);
    }
    if (armed) disarm(false); // stale gesture loses
    if (e.touches.length !== 1 || state.generating) return;

    const target = e.target instanceof Element ? e.target : null;
    const msgEl = target && target.closest('.scp-msg');
    if (!msgEl || msgEl.classList.contains('is-editing')) return;
    // Already-selecting message: native selection is live there, stay out.
    if (msgEl.classList.contains('scp-selecting') || (target && target.closest(SKIP_SEL))) return;

    const t = e.touches[0];
    armed = {
        msgEl, x: t.clientX, y: t.clientY, id: t.identifier, activated: false,
        timer: setTimeout(activate, HOLD_MS),
    };
    feed.addEventListener('touchmove', onTouchMove, { passive: false });
    feed.addEventListener('touchend', onTouchEnd);
    feed.addEventListener('touchcancel', onTouchEnd);
}

function onTouchMove(e) {
    if (!armed) return;
    const t = [...e.touches].find(t => t.identifier === armed.id);
    if (!t) return;
    if (!armed.activated) {
        const dx = t.clientX - armed.x, dy = t.clientY - armed.y;
        // Slop exceeded before the hold fired: it is a scroll, stand down
        // (do NOT preventDefault — the native pan must proceed).
        if (dx * dx + dy * dy > SLOP_PX * SLOP_PX) disarm(false);
        return;
    }
    // Pan never started (finger was stationary through the hold), so
    // blocking it here turns the rest of the drag into selection movement.
    e.preventDefault();
}

function onTouchEnd() {
    disarm(true); // keep the seeded selection: user drags handles next
}

function activate() {
    const a = armed;
    if (!a || state.generating) { if (a) disarm(false); return; }
    const range = caretRange(a.x, a.y);
    const zones = range ? [...a.msgEl.querySelectorAll('.scp-msg-content, .scp-reasoning-content')] : [];
    if (!zones.some(z => z.contains(range.startContainer))) { disarm(false); return; }

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (typeof sel.modify === 'function') {
        // Word under the finger: caret -> end of word -> start of word.
        sel.modify('extend', 'forward', 'word');
        sel.modify('extend', 'backward', 'word');
    }
    a.msgEl.classList.add('scp-selecting');
    a.activated = true;
}

function disarm(keepSelection) {
    const a = armed;
    armed = null;
    if (!a) return;
    clearTimeout(a.timer);
    feed.removeEventListener('touchmove', onTouchMove);
    feed.removeEventListener('touchend', onTouchEnd);
    feed.removeEventListener('touchcancel', onTouchEnd);
    if (!keepSelection && a.activated) exitSelectMode(a.msgEl);
}

function exitSelectMode(msgEl) {
    // Clear the native selection BEFORE dropping the class, or Android
    // leaves orphaned selection handles floating on screen.
    window.getSelection().removeAllRanges();
    msgEl.classList.remove('scp-selecting');
}

function caretRange(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint && document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
}
