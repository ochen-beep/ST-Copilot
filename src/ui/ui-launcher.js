// v2.10.0 — Launcher buttons for the Copilot window.
// Mounts a button into SillyTavern's quick-reply bar (#qr--bar) like DS Comments,
// plus an optional floating dock-icon FAB, plus a fullscreen mobile mode with
// ST-chrome inset measurement.
//
// launcherMode setting ('bar' | 'floating' | 'both') picks which launcher(s) are
// shown: the inline quick-reply bar button, the floating FAB, or both.

import { getSettings, saveSettings } from '../session.js';
import { state } from '../state.js';
import { WIN_ID, EXT_DISPLAY, ICON_ID, ICON_STORAGE_KEY, I } from '../constants.js';

const LAUNCHER_ID = 'scp-launcher';
const ST_TOPBAR_SEL = '#top-bar';
const ST_SENDFORM_SEL = '#send_form';
const ST_TOPBAR_FALLBACK = 40;
const ST_SENDFORM_FALLBACK = 120;
const ICON_SIZE = 46;

// Toggle handler wired by index.js (toggleVisibility). Stored at module level so
// re-mounts after ST rebuilds #send_form keep the same behaviour.
let _toggleHandler = null;

function isMobileViewport() {
    return window.innerWidth <= 900 || ('ontouchstart' in window && window.innerWidth <= 1366);
}

function getLauncherMode() {
    return getSettings().launcherMode || 'bar';
}

// ─── ST chrome measurement ──────────────────────────────────────
// Writes --scp-st-top / --scp-st-bottom on <html> so the mobile fullscreen
// window can avoid covering SillyTavern's own fixed bars.
function measureStChrome() {
    const root = document.documentElement;
    let topH = 0, bottomH = 0;

    const topBar = document.querySelector(ST_TOPBAR_SEL);
    if (topBar) {
        const r = topBar.getBoundingClientRect();
        topH = (r.bottom > 0 && r.bottom <= 200) ? Math.round(r.bottom) : ST_TOPBAR_FALLBACK;
    } else {
        topH = ST_TOPBAR_FALLBACK;
    }

    const sendForm = document.querySelector(ST_SENDFORM_SEL);
    if (sendForm) {
        const r = sendForm.getBoundingClientRect();
        const vh = window.innerHeight;
        const distFromBottom = vh - r.top;
        bottomH = (distFromBottom > 0 && distFromBottom <= 400) ? Math.round(distFromBottom) : ST_SENDFORM_FALLBACK;
    } else {
        bottomH = ST_SENDFORM_FALLBACK;
    }

    root.style.setProperty('--scp-st-top', `${topH}px`);
    root.style.setProperty('--scp-st-bottom', `${bottomH}px`);
}

// ─── Launcher host discovery ────────────────────────────────────
function getQuickReplyBar() {
    return document.querySelector('#send_form #qr--bar')
        || document.getElementById('qr--bar')
        || document.querySelector('#send_form .qr--bar');
}

function getLauncherHost() {
    const qrBar = getQuickReplyBar();
    if (!qrBar) return null;
    return qrBar.querySelector('.qr--buttons') || qrBar;
}

// ─── Visibility sync ────────────────────────────────────────────
function isWindowVisible() {
    const s = getSettings();
    return !!s.enabled && s.windowVisible && !s.minimized;
}

function syncLauncherState() {
    const btn = document.getElementById(LAUNCHER_ID);
    if (btn) {
        btn.classList.toggle('scp_launcher_active', isWindowVisible());
        // Pulse during generation
        btn.classList.toggle('scp_generating', !!state.generating);
    }
    syncFloatingIcon();
}

// ─── Bar launcher mount ─────────────────────────────────────────
let _launcherObserver = null;

export function ensureLauncher({ onToggle } = {}) {
    const s = getSettings();
    if (onToggle) _toggleHandler = onToggle;
    const existing = document.getElementById(LAUNCHER_ID);
    const mode = getLauncherMode();
    const wantBar = mode === 'bar' || mode === 'both';
    const wantFab = mode === 'floating' || mode === 'both';

    if (!s.enabled) {
        if (existing) existing.remove();
        document.body.classList.remove('scp-launcher-mounted');
        removeFloatingIcon();
        return null;
    }

    // ── Bar launcher ──
    let btn = null;
    if (wantBar) {
        const host = getLauncherHost();
        if (host) {
            btn = existing;
            if (!btn) {
                btn = document.createElement('div');
                btn.id = LAUNCHER_ID;
                // Reuse ST's own button chrome classes for native look.
                btn.className = 'qr--button menu_button interactable scp-launcher';
                btn.tabIndex = 0;
                btn.setAttribute('role', 'button');
                btn.setAttribute('aria-label', EXT_DISPLAY);
                btn.title = EXT_DISPLAY;
                // Brain emoji — signals "AI assistant". Avoids the 💬 speech bubble, which
                // DS Comments already uses for its own launcher in this same quick-reply bar.
                btn.innerHTML = '<span aria-hidden="true">🧠</span>';

                const toggle = () => { if (_toggleHandler) _toggleHandler(); else defaultToggle(); };
                btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
                btn.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                });
            }
            if (btn.parentElement !== host) host.appendChild(btn);
            document.body.classList.add('scp-launcher-mounted');
        }
    }
    if (!btn && existing) existing.remove();
    if (!wantBar) document.body.classList.remove('scp-launcher-mounted');

    // ── Floating icon ──
    if (wantFab) ensureFloatingIcon(); else removeFloatingIcon();

    syncLauncherState();
    return btn;
}

function defaultToggle() {
    const s = getSettings();
    if (!s.enabled) return;
    if (isWindowVisible()) {
        // hide
        const winEl = document.getElementById(WIN_ID);
        if (winEl) winEl.style.display = 'none';
        s.windowVisible = false;
        s.minimized = false;
        state.copilotActive = false;
        saveSettings();
    } else {
        // show
        const winEl = document.getElementById(WIN_ID);
        if (winEl) winEl.style.display = 'flex';
        s.windowVisible = true;
        s.minimized = false;
        state.copilotActive = true;
        saveSettings();
        applyMobileMode();
    }
    syncLauncherState();
}

// Re-mount the launcher whenever ST rebuilds #send_form (chat switch, group change).
export function watchLauncherHost() {
    if (_launcherObserver) _launcherObserver.disconnect();
    const sendForm = document.querySelector('#send_form') || document.body;
    // RAF-коалесцинг: мутации поддерева send_form идут пачками (печать, тулбары),
    // ensureLauncher() достаточно позвать один раз на кадр.
    let _moRaf = 0;
    _launcherObserver = new MutationObserver(() => {
        if (_moRaf) return;
        _moRaf = requestAnimationFrame(() => { _moRaf = 0; ensureLauncher(); });
    });
    _launcherObserver.observe(sendForm, { childList: true, subtree: true });
}

// Refresh launcher state from outside (e.g. after generation starts/stops, window toggled).
export function refreshLauncher() {
    syncLauncherState();
}

// ─── Floating launcher icon (FAB) ───────────────────────────────
// v2.10.0+: the dock-icon FAB is back as an optional launcher mode
// ('floating' | 'both'). Position persists in localStorage under the legacy key
// (scp-icon-position), so positions saved by v2.9.0 are picked up.

let _fabResizeBound = false;

function getFloatingIcon() {
    return document.getElementById(ICON_ID);
}

function removeFloatingIcon() {
    const icon = getFloatingIcon();
    if (icon) icon.remove();
}

function restoreIconPosition(icon) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = isMobileViewport();

    let posValid = false;
    const saved = localStorage.getItem(ICON_STORAGE_KEY);
    if (saved) {
        try {
            const pos = JSON.parse(saved);
            const left = parseFloat(pos.left);
            const top = parseFloat(pos.top);
            if (!isNaN(left) && !isNaN(top) && left >= 0 && top >= 0 && left + ICON_SIZE <= vw && top + ICON_SIZE <= vh) {
                icon.style.left = `${left}px`;
                icon.style.top = `${top}px`;
                icon.style.bottom = 'auto';
                icon.style.right = 'auto';
                posValid = true;
            }
        } catch {
            localStorage.removeItem(ICON_STORAGE_KEY);
        }
    }
    if (!posValid) {
        const defaultRight = isMobile ? 16 : 20;
        const defaultBottom = isMobile ? 120 : 80;
        icon.style.left = `${Math.max(0, vw - ICON_SIZE - defaultRight)}px`;
        icon.style.top = `${Math.max(0, vh - ICON_SIZE - defaultBottom)}px`;
        icon.style.bottom = 'auto';
        icon.style.right = 'auto';
    }
}

// Keep the FAB inside the viewport when the window resizes.
function clampIconPosition() {
    const icon = getFloatingIcon();
    if (!icon || icon.style.display === 'none') return;
    const curLeft = parseFloat(icon.style.left);
    const curTop = parseFloat(icon.style.top);
    if (isNaN(curLeft) || isNaN(curTop)) return;
    icon.style.left = `${Math.max(0, Math.min(curLeft, window.innerWidth - ICON_SIZE))}px`;
    icon.style.top = `${Math.max(0, Math.min(curTop, window.innerHeight - ICON_SIZE))}px`;
}

function syncFloatingIcon() {
    const icon = getFloatingIcon();
    if (!icon) return;
    const s = getSettings();
    const mode = getLauncherMode();
    if (!s.enabled || (mode !== 'floating' && mode !== 'both')) {
        icon.style.setProperty('display', 'none', 'important');
        return;
    }
    icon.classList.toggle('scp_generating', !!state.generating);
    // Show the FAB whenever the window is closed; hide it while the window is
    // open so it never overlaps the panel. Reappears as soon as the window closes.
    if (!s.windowVisible || s.minimized) {
        icon.style.setProperty('display', 'flex', 'important');
    } else {
        icon.style.setProperty('display', 'none', 'important');
    }
}

export function ensureFloatingIcon({ onToggle } = {}) {
    if (onToggle) _toggleHandler = onToggle;
    let icon = getFloatingIcon();
    if (!icon) {
        icon = document.createElement('div');
        icon.id = ICON_ID;
        icon.className = 'scp-dock-icon';
        icon.style.display = 'none';
        icon.title = `${EXT_DISPLAY} — нажмите, чтобы открыть`;
        icon.setAttribute('role', 'button');
        icon.tabIndex = 0;
        icon.innerHTML = `${I.bot}<span class="scp-dock-pulse"></span>`;

        icon.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (_toggleHandler) _toggleHandler(); else defaultToggle();
            }
        });

        document.body.appendChild(icon);
        restoreIconPosition(icon);
        makeIconDraggable(icon);
        if (!_fabResizeBound) {
            _fabResizeBound = true;
            window.addEventListener('resize', clampIconPosition);
        }
    }
    syncLauncherState();
    return icon;
}

// Drag-and-drop for the FAB (ported from v2.9.0): click (no drag) toggles the
// window, dragging moves the icon and persists the new position.
function makeIconDraggable(icon) {
    let dragging = false;
    let active = false;
    let offsetX = 0, offsetY = 0;
    let startX = 0, startY = 0;
    let _rafId = null;

    let tx = 0, ty = 0;
    let cx = 0, cy = 0;
    let vx = 0, vy = 0;

    let stretch = 0;
    let vStretch = 0;
    let angle = 0;

    const settle = () => {
        icon.style.transform = '';
        icon.style.left = `${tx}px`;
        icon.style.top = `${ty}px`;
        _rafId = null;
        vx = vy = stretch = vStretch = 0;
        try {
            localStorage.setItem(ICON_STORAGE_KEY, JSON.stringify({
                left: icon.style.left,
                top: icon.style.top,
            }));
        } catch (_) {}
    };

    const tick = () => {
        const isWobbly = getSettings().wobbleWindow !== false && !getSettings().performanceMode;

        if (!active && !dragging &&
            Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05 &&
            Math.abs(tx - cx) < 0.5 && Math.abs(ty - cy) < 0.5 &&
            Math.abs(stretch) < 0.005 && Math.abs(vStretch) < 0.005) {
            settle();
            return;
        }

        if (isWobbly) {
            const tension = 0.28;
            const friction = 0.62;

            const dx = tx - cx;
            const dy = ty - cy;

            vx = (vx + dx * tension) * friction;
            vy = (vy + dy * tension) * friction;
            cx += vx;
            cy += vy;

            const speed = Math.sqrt(vx * vx + vy * vy);
            const targetStretch = Math.min(0.35, speed * 0.015);

            const sTension = 0.22;
            const sFriction = 0.68;
            const dStretch = targetStretch - stretch;
            vStretch = (vStretch + dStretch * sTension) * sFriction;
            stretch += vStretch;

            if (speed > 0.5) {
                angle = Math.atan2(vy, vx) * (180 / Math.PI);
            }

            icon.style.left = `${cx}px`;
            icon.style.top = `${cy}px`;
            icon.style.transform = `rotate(${angle}deg) scale(${1 + stretch}, ${1 - stretch}) rotate(${-angle}deg)`;
        } else {
            cx = tx; cy = ty;
            vx = vy = stretch = vStretch = 0;
            icon.style.transform = '';
            icon.style.left = `${tx}px`;
            icon.style.top = `${ty}px`;
        }

        _rafId = requestAnimationFrame(tick);
    };

    icon.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        dragging = false;
        active = true;

        const r = icon.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;

        startX = r.left;
        startY = r.top;

        cx = r.left;
        cy = r.top;
        tx = cx;
        ty = cy;
        vx = vy = stretch = vStretch = 0;

        icon.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    icon.addEventListener('pointermove', e => {
        if (!icon.hasPointerCapture(e.pointerId)) return;

        const rawX = e.clientX - offsetX;
        const rawY = e.clientY - offsetY;

        tx = Math.max(0, Math.min(window.innerWidth - ICON_SIZE, rawX));
        ty = Math.max(0, Math.min(window.innerHeight - ICON_SIZE, rawY));

        const moveDist = Math.sqrt((tx - startX) * (tx - startX) + (ty - startY) * (ty - startY));
        if (!dragging && moveDist > 6) {
            dragging = true;
            icon.classList.add('scp-icon-dragging');
        }

        if (!_rafId) _rafId = requestAnimationFrame(tick);
    });

    icon.addEventListener('pointerup', e => {
        if (icon.hasPointerCapture(e.pointerId)) {
            icon.releasePointerCapture(e.pointerId);
        }
        active = false;
        icon.classList.remove('scp-icon-dragging');

        if (dragging) {
            dragging = false;
        } else if (_toggleHandler) {
            _toggleHandler();
        } else {
            defaultToggle();
        }
    });

    icon.addEventListener('pointercancel', e => {
        if (icon.hasPointerCapture(e.pointerId)) {
            icon.releasePointerCapture(e.pointerId);
        }
        dragging = false;
        active = false;
        icon.classList.remove('scp-icon-dragging');
    });

    icon.style.touchAction = 'none';
}

// ─── Mobile fullscreen mode ─────────────────────────────────────
export function applyMobileMode() {
    const winEl = document.getElementById(WIN_ID);
    if (!winEl) return;
    if (!isMobileViewport()) {
        winEl.classList.remove('scp_mobile');
        return;
    }
    measureStChrome();
    winEl.style.transform = '';
    winEl.style.left = '';
    winEl.style.top = '';
    winEl.style.right = '';
    winEl.style.bottom = '';
    winEl.style.width = '';
    winEl.style.height = '';
    winEl.classList.add('scp_mobile');
}

let _viewportTimer = null;
export function initViewportSync() {
    const handler = () => {
        if (_viewportTimer) clearTimeout(_viewportTimer);
        _viewportTimer = setTimeout(() => {
            measureStChrome();
            applyMobileMode();
        }, 200);
    };
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
}

let _chromeObserver = null;
export function observeStChrome() {
    if (_chromeObserver) _chromeObserver.disconnect();
    const sendForm = document.querySelector(ST_SENDFORM_SEL);
    if (!sendForm) return;
    let debounce = null;
    _chromeObserver = new ResizeObserver(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { measureStChrome(); applyMobileMode(); }, 200);
    });
    _chromeObserver.observe(sendForm);
}
