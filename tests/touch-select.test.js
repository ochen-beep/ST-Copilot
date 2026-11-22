// Long-press touch selection arbitration (src/ui/touch-select.js).
//
// jsdom has no TouchEvent / caretRangeFromPoint / Selection.modify, so the
// tests drive plain bubbling Events with a fake `touches` array and mock
// the caret lookup with a real Range into fixture text. Covers the contract:
// hold activates one message, movement cancels for scrolling, interactive
// targets are skipped, the mode exits on the next touch elsewhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../src/state.js';

const { setupTouchTextSelection } = await import('../src/ui/touch-select.js');

const FIXTURE = `<div id="scp-messages">
  <div class="scp-msg scp-msg-assistant">
    <div class="scp-msg-body">
      <div class="scp-msg-content"><p>hello world text</p></div>
    </div>
  </div>
  <div class="feed-sibling">outside</div>
</div>`;

let feed, msgEl, textNode, caretSpy;

function touch(el, type, x, y) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    e.touches = [{ identifier: 1, clientX: x, clientY: y }];
    el.dispatchEvent(e);
    return e; // preventDefault assertions go through e.defaultPrevented
}

describe('touch-select arbitration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = FIXTURE;
        feed = document.getElementById('scp-messages');
        msgEl = feed.querySelector('.scp-msg');
        textNode = feed.querySelector('.scp-msg-content p').firstChild;
        caretSpy = vi.fn(() => {
            const r = document.createRange();
            r.setStart(textNode, 2);
            r.collapse(true);
            return r;
        });
        document.caretRangeFromPoint = caretSpy;
        setupTouchTextSelection();
    });

    afterEach(() => {
        vi.useRealTimers();
        window.getSelection().removeAllRanges();
        delete document.caretRangeFromPoint;
        document.body.innerHTML = '';
    });

    it('hold without movement opts the message in and seeds a word selection', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        expect(msgEl.classList.contains('scp-selecting')).toBe(true);
        expect(window.getSelection().rangeCount).toBe(1);
        expect(caretSpy).toHaveBeenCalledWith(10, 10);
    });

    it('selection and mode survive touchend (user drags handles next)', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        touch(feed, 'touchend', 10, 10);
        expect(msgEl.classList.contains('scp-selecting')).toBe(true);
        expect(window.getSelection().rangeCount).toBe(1);
    });

    it('movement beyond slop before the hold fires cancels without blocking scroll', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        const mv = touch(feed, 'touchmove', 10, 60); // 50px drag = a scroll
        expect(msgEl.classList.contains('scp-selecting')).toBe(false);
        expect(window.getSelection().rangeCount).toBe(0);
        expect(mv.defaultPrevented).toBe(false);
    });

    it('movement after activation is prevented so the drag extends selection', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        const mv = touch(feed, 'touchmove', 10, 40);
        expect(mv.defaultPrevented).toBe(true);
    });

    it('small jitter before activation does not preventDefault', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        const mv = touch(feed, 'touchmove', 12, 12);
        expect(mv.defaultPrevented).toBe(false);
    });

    it('skips interactive targets (buttons) entirely', () => {
        const btn = document.createElement('button');
        btn.textContent = 'act';
        msgEl.querySelector('.scp-msg-body').appendChild(btn);
        touch(btn, 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        expect(msgEl.classList.contains('scp-selecting')).toBe(false);
    });

    it('skips arming while generating', () => {
        state.generating = true;
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        state.generating = false;
        expect(msgEl.classList.contains('scp-selecting')).toBe(false);
    });

    it('next touch outside the selecting message exits the mode cleanly', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        touch(feed.querySelector('.feed-sibling'), 'touchstart', 5, 5);
        expect(msgEl.classList.contains('scp-selecting')).toBe(false);
        expect(window.getSelection().rangeCount).toBe(0);
    });

    it('touch inside the already-selecting message re-enters native behavior, not a second hold', () => {
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        const p = feed.querySelector('.scp-msg-content p');
        touch(p, 'touchstart', 12, 12);
        vi.advanceTimersByTime(400);
        expect(msgEl.classList.contains('scp-selecting')).toBe(true);
    });

    it('does not double-bind the listeners', () => {
        setupTouchTextSelection();
        touch(feed.querySelector('.scp-msg-content'), 'touchstart', 10, 10);
        vi.advanceTimersByTime(400);
        // A second bind would have armed a second timer on the same gesture;
        // one selection is the observable proof it did not.
        expect(window.getSelection().rangeCount).toBe(1);
    });
});
