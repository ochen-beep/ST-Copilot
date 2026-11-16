// Scroll stick-to-bottom state machine: escape by wheel intent and by
// up-direction scrolling, re-arm only when the view lands at the bottom.
//
// The previous listener used a distance threshold (dist > 80px): stream
// chunks snapped the view back while the wheel animation was still inside
// the threshold window, so the feed felt glued to the bottom edge.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/index.js', () => ({
    ST_WorldInfo: null,
    ST_Utils: null,
    extVersion: 'test',
    __extPath: 'third-party/ST-Copilot',
    refreshSessionDropdown: () => {},
}));

const { setupMessagesScrollTracking } = await import('../src/ui/msg-actions.js');
const { state } = await import('../src/state.js');

function makeFeed() {
    const el = document.createElement('div');
    el.id = 'scp-messages';
    document.body.appendChild(el);
    let height = 1000, top = 0;
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v) => { top = v; }, configurable: true });
    return {
        el,
        set(h, t) { height = h; top = t; },
    };
}

const scroll = (el) => el.dispatchEvent(new Event('scroll'));
const wheel = (el, deltaY) => {
    const ev = new Event('wheel', { bubbles: true });
    Object.defineProperty(ev, 'deltaY', { value: deltaY });
    el.dispatchEvent(ev);
};

describe('setupMessagesScrollTracking', () => {
    let feed;
    beforeEach(() => {
        document.getElementById('scp-messages')?.remove();
        feed = makeFeed();
        state.userScrolledUp = false;
        setupMessagesScrollTracking();
    });
    afterEach(() => { feed.el.remove(); });

    it('wheel up escapes stickiness instantly (intent, not position)', () => {
        feed.set(1000, 500); // at bottom
        wheel(feed.el, -120);
        expect(state.userScrolledUp).toBe(true);
    });

    it('wheel down does not escape', () => {
        feed.set(1000, 500);
        wheel(feed.el, 120);
        expect(state.userScrolledUp).toBe(false);
    });

    it('wheel up is ignored when content does not overflow', () => {
        feed.set(500, 0);
        wheel(feed.el, -120);
        expect(state.userScrolledUp).toBe(false);
    });

    it('scrolling up (scrollbar/touch) escapes at any distance', () => {
        feed.set(1000, 500);
        scroll(feed.el); // baseline: at bottom
        feed.set(1000, 470); // 30px up — inside the old 80px window
        scroll(feed.el);
        expect(state.userScrolledUp).toBe(true);
    });

    it('landing back at the bottom re-arms stickiness', () => {
        feed.set(1000, 500);
        scroll(feed.el); // baseline
        feed.set(1000, 300);
        scroll(feed.el); // escape via up direction
        expect(state.userScrolledUp).toBe(true);
        feed.set(1100, 600); // user scrolled back down as the content grew
        scroll(feed.el);
        expect(state.userScrolledUp).toBe(false);
    });

    it('programmatic stick-to-bottom keeps the view stuck while streaming', () => {
        feed.set(1000, 500);
        scroll(feed.el); // baseline: at bottom
        feed.set(1100, 600); // chunk grew content, autoscroll snapped down
        scroll(feed.el);
        expect(state.userScrolledUp).toBe(false);
    });
});
