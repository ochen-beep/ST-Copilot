import { getSettings, saveSettings } from '../session.js';
import { state } from '../state.js';
import { THEME_CSS_MAP, THEME_PRESETS, WIN_ID, EXT_DISPLAY } from '../constants.js';
import { saveScrollPosition, restoreScrollPosition } from './ui-chat.js';

const SCP_TOP_Z_INDEX = 2147483000;
const WIN_POS_STORAGE_KEY = 'scp-win-pos';

export function bringWindowToFront() {
    const targets = Array.from(document.body.children).filter(el =>
        el.id?.startsWith('scp-') || el.classList?.contains('scp-dialog-overlay')
    );
    
    const getLayer = (el) => {
        if (el.classList?.contains('scp-dialog-overlay')) return 50;
        if (el.id?.endsWith('-modal')) return 40;
        if (el.id?.endsWith('-overlay')) return 30;
        if (el.id === 'scp-dock-icon') return 20;
        return 10;
    };

    for (const el of targets) {
        el.style.zIndex = String(SCP_TOP_Z_INDEX + getLayer(el));
    }
}

export function makeDraggable(handle, target) {
    // v2.10.0: simplified to straight drag — no wobble/spring physics (performance).
    let active = false, offsetX = 0, offsetY = 0;

    handle.addEventListener('pointerdown', e => {
        if (e.target.closest('.scp-hbtn,.scp-tbtn,select,input,button,.scp-opacity-wrap,.scp-rh,.scp-sess-dropdown,.scp-sess-wrap,.scp-menu-dropdown,.scp-pick-wrap,.scp-ctx-widget,.scp-depth-clickable,.scp-char-badge,.scp-pick-badge')) return;

        // Skip drag on mobile — window is fullscreen there.
        const isMobile = window.innerWidth <= 900 || ('ontouchstart' in window && window.innerWidth <= 1366);
        if (isMobile) return;

        const r = target.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;

        active = true;
        handle.setPointerCapture(e.pointerId);
        target.classList.add('scp-dragging');
        e.preventDefault();
    });

    handle.addEventListener('pointermove', e => {
        if (!active) return;
        const left = Math.max(0, Math.min(window.innerWidth - target.offsetWidth, e.clientX - offsetX));
        const top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offsetY));
        target.style.left = `${left}px`;
        target.style.top = `${top}px`;
        target.style.right = 'auto';
    });

    const endDrag = e => {
        if (!active) return;
        active = false;
        try { handle.releasePointerCapture(e.pointerId); } catch(_) {}
        target.classList.remove('scp-dragging');
        saveWindowState(target);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
}

export function makeResizable(target) {
    const MIN_W = 320, MIN_H = 300;
    // v2.10.0: resize disabled on mobile — window is fullscreen there.
    const isMobile = window.innerWidth <= 900 || ('ontouchstart' in window && window.innerWidth <= 1366);
    if (isMobile) {
        target.querySelectorAll('.scp-rh').forEach(h => { h.style.display = 'none'; });
        return;
    }
    target.querySelectorAll('.scp-rh').forEach(h => {
        const dir = [...h.classList].find(c => /^scp-rh-\w/.test(c))?.replace('scp-rh-', '') || '';
        let active = false, sw, sh, sl, st, sx, sy, _rafId = null, _s = {};

        const flush = () => {
            if (_s.w !== undefined) target.style.width = `${_s.w}px`;
            if (_s.h !== undefined) target.style.height = `${_s.h}px`;
            if (_s.l !== undefined) { target.style.left = `${_s.l}px`; target.style.right = 'auto'; }
            if (_s.t !== undefined) target.style.top = `${_s.t}px`;
            _rafId = null;
        };

        h.addEventListener('pointerdown', e => {
            e.preventDefault(); e.stopPropagation();
            active = true; _s = {};
            const r = target.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; sl = r.left; st = r.top;
            h.setPointerCapture(e.pointerId);
            target.classList.add('scp-resizing');
        });

        h.addEventListener('pointermove', e => {
            if (!active) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            _s = {};
            if (dir.includes('e')) _s.w = Math.max(MIN_W, sw + dx);
            if (dir.includes('s')) _s.h = Math.max(MIN_H, sh + dy);
            if (dir.includes('w')) { const nw = Math.max(MIN_W, sw - dx); _s.w = nw; _s.l = sl + (sw - nw); }
            if (dir.includes('n')) { const nh = Math.max(MIN_H, sh - dy); _s.h = nh; _s.t = st + (sh - nh); }
            if (!_rafId) _rafId = requestAnimationFrame(flush);
        });

        h.addEventListener('pointerup', e => {
            if (!active) return;
            active = false;
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; flush(); }
            target.classList.remove('scp-resizing');
            saveWindowState(target);
        });

        h.addEventListener('pointercancel', () => {
            active = false;
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            target.classList.remove('scp-resizing');
        });

        h.style.touchAction = 'none';
    });
}

// v2.10.0: FAB drag/drop и видимость плавающей иконки живёт в ui-launcher.js.

export function saveWindowState(windowEl) {
    if (!windowEl) return;
    const r = windowEl.getBoundingClientRect();
    try { 
        localStorage.setItem(WIN_POS_STORAGE_KEY, JSON.stringify({ 
            x: r.left, y: r.top, w: r.width, h: r.height 
        })); 
    } catch(_) {}
}

export function applyCustomTheme(theme) {
    if (!theme) return;
    
    // Lazy get elements just to be safe
    const windowEl = document.getElementById(WIN_ID);
    const iconEl = document.getElementById('scp-dock-icon');
    const targets = [
        windowEl, 
        iconEl, 
        document.getElementById('scp-lb-overlay'), 
        document.getElementById('scp-char-overlay'),
        document.getElementById('scp-diff-modal'), 
        document.getElementById('scp-settings-overlay'), 
        document.getElementById('scp-picker-overlay')
    ].filter(Boolean);
    const s = getSettings();
    
    for (const [key, cssVar] of Object.entries(THEME_CSS_MAP)) {
        if (key === 'font' || key === 'fontSize') continue;
        if (theme[key] !== undefined && theme[key] !== '') {
            let val = theme[key];
            
            if (s.performanceMode) {
                if (key === 'blur') val = 'none';
                if (key === 'shadow') val = '0 8px 24px rgba(0,0,0,0.85)';
                if (key === 'bg' && val.includes('rgba')) {
                    val = val.replace(/,\s*0\.[0-8]\d*\)/, ', 0.96)');
                }
            }

            targets.forEach(t => t.style.setProperty(cssVar, val));
        }
    }
    const fontVal = (theme.font || '').trim();
    targets.forEach(t => fontVal
        ? t.style.setProperty('--scp-font', fontVal)
        : t.style.removeProperty('--scp-font'));
        
    let fontSizeVal = (theme.fontSize || '').trim();
    if (/^\d+$/.test(fontSizeVal)) fontSizeVal += 'px';
    
    targets.forEach(t => {
        if (fontSizeVal) {
            t.style.setProperty('--scp-font-size', fontSizeVal);
            t.style.fontSize = fontSizeVal;
        } else {
            t.style.removeProperty('--scp-font-size');
            t.style.fontSize = '';
        }
    });
}

export function applyWindowBackground() {
    // v2.10.0: Custom image/video backgrounds removed for performance.
    // Function kept as no-op for backward-compat with settings UI calls.
    const windowEl = document.getElementById(WIN_ID);
    if (!windowEl) return;
    windowEl.style.removeProperty('--scp-bg-image');
    windowEl.style.removeProperty('--scp-bg-dim');
    windowEl.classList.remove('scp-has-bg');
    const mediaEl = document.getElementById('scp-bg-media');
    if (mediaEl) mediaEl.remove();
}

export function restoreWindowState(windowEl) {
    const s = getSettings(); if (!windowEl) return;
    const isMobile = window.innerWidth <= 900 || ('ontouchstart' in window && window.innerWidth <= 1366);

    let w = 440;
    let h = 600;
    let posRestored = false;

    try {
        const saved = localStorage.getItem(WIN_POS_STORAGE_KEY);
        if (saved) {
            const { x, y, w: savedW, h: savedH } = JSON.parse(saved);
            if (savedW) w = savedW;
            if (savedH) h = savedH;

            if (x != null && y != null) {
                const maxLeft = Math.max(0, window.innerWidth - (isMobile ? window.innerWidth * 0.94 : w));
                windowEl.style.left = `${Math.max(0, Math.min(x, maxLeft))}px`;
                windowEl.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 100))}px`;
                windowEl.style.right = 'auto';
                posRestored = true;
            }
        }
    } catch(_) {}

    if (!posRestored) {
        if (s.windowW) w = s.windowW;
        if (s.windowH) h = s.windowH;

        if (s.windowX !== null && s.windowX !== undefined) {
            const maxLeft = Math.max(0, window.innerWidth - (isMobile ? window.innerWidth * 0.94 : w));
            windowEl.style.left = `${Math.max(0, Math.min(s.windowX, maxLeft))}px`;
            windowEl.style.top = `${Math.max(0, Math.min(s.windowY ?? 80, window.innerHeight - 100))}px`;
            windowEl.style.right = 'auto';
            try { localStorage.setItem(WIN_POS_STORAGE_KEY, JSON.stringify({ x: s.windowX, y: s.windowY, w, h })); } catch(_) {}
        } else if (isMobile) {
            windowEl.style.left = '3vw';
            windowEl.style.top = '8vh';
            windowEl.style.right = 'auto';
        }
    }

    if (isMobile) {
        windowEl.style.width = `${Math.min(w, Math.floor(window.innerWidth * 0.94), 560)}px`;
        windowEl.style.height = `${Math.min(h, Math.floor(window.innerHeight * 0.82), 700)}px`;
    } else {
        windowEl.style.width = `${w}px`;
        windowEl.style.height = `${h}px`;
    }
    // v2.10.0: window is always solid (opacity 1) for performance; opacity only used by Ghost Mode.
    windowEl.style.opacity = '1';
    applyCustomTheme(s.customTheme || THEME_PRESETS.default);
    applyWindowBackground();
}

export function setGhostMode(enabled) {
    const windowEl = document.getElementById(WIN_ID);
    state.ghostModeActive = enabled;
    if (!windowEl) return;
    const s = getSettings();
    const ghostBtn = document.getElementById('scp-ghost-btn');

    if (enabled) {
        const opacity = Math.max(15, Math.min(50, s.ghostModeOpacity ?? 15)) / 100;
        windowEl.classList.add('scp-ghost-mode');
        windowEl.style.opacity = opacity.toString();
        ghostBtn?.classList.add('active');
    } else {
        windowEl.classList.remove('scp-ghost-mode');
        windowEl.style.opacity = '1';
        ghostBtn?.classList.remove('active');
    }
}

export function toggleGhostMode() {
    const windowEl = document.getElementById(WIN_ID);
    if (!windowEl || windowEl.style.display === 'none') return;
    setGhostMode(!state.ghostModeActive);
}

let _hotkeyHandler = null;
export function setupHotkey() {
    if (_hotkeyHandler) document.removeEventListener('keydown', _hotkeyHandler);
    _hotkeyHandler = null;
    const s = getSettings();
    if (!s.enabled || !s.hotkeyEnabled || !s.hotkey) return;
    const parts = s.hotkey.toLowerCase().split('+').map(p => p.trim());
    const key = parts[parts.length - 1];
    const needAlt = parts.includes('alt'), needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needShift = parts.includes('shift'), needMeta = parts.includes('meta') || parts.includes('cmd');
    _hotkeyHandler = e => {
        if (e.key.toLowerCase() !== key) return;
        if (needAlt !== e.altKey || needCtrl !== e.ctrlKey || needShift !== e.shiftKey || needMeta !== e.metaKey) return;
        const active = document.activeElement;
        if (active && active !== document.getElementById('scp-input') && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
        e.preventDefault(); toggleVisibility();
    };
    document.addEventListener('keydown', _hotkeyHandler);
}

let _ghostHotkeyHandler = null;
export function setupGhostHotkey() {
    if (_ghostHotkeyHandler) document.removeEventListener('keydown', _ghostHotkeyHandler);
    _ghostHotkeyHandler = null;
    const s = getSettings();
    if (!s.ghostModeHotkeyEnabled || !s.ghostModeHotkey) return;
    const parts = s.ghostModeHotkey.toLowerCase().split('+').map(p => p.trim());
    const key = parts[parts.length - 1];
    const needAlt = parts.includes('alt');
    const needCtrl = parts.includes('ctrl') || parts.includes('control');
    const needShift = parts.includes('shift');
    const needMeta = parts.includes('meta') || parts.includes('cmd');
    _ghostHotkeyHandler = e => {
        if (e.key.toLowerCase() !== key) return;
        if (needAlt !== e.altKey || needCtrl !== e.ctrlKey || needShift !== e.shiftKey || needMeta !== e.metaKey) return;
        e.preventDefault();
        toggleGhostMode();
    };
    document.addEventListener('keydown', _ghostHotkeyHandler);
}

export function minimize() {
    saveScrollPosition();
    const windowEl = document.getElementById(WIN_ID);
    setGhostMode(false);
    const s = getSettings();
    s.minimized = true;
    if(windowEl) windowEl.style.display = 'none';
    state.copilotActive = false;
    saveSettings();
    _syncLauncher();
}

export function hideWindow() {
    saveScrollPosition();
    const windowEl = document.getElementById(WIN_ID);
    setGhostMode(false);
    const s = getSettings();
    s.windowVisible = false;
    s.minimized = false;
    if(windowEl) windowEl.style.display = 'none';
    state.copilotActive = false;
    saveSettings();
    _syncLauncher();
}

export function showWindow() {
    const windowEl = document.getElementById(WIN_ID);
    const s = getSettings();
    if (!s.enabled) { toastr.warning('ST-Copilot отключён.', EXT_DISPLAY); return; }
    s.windowVisible = true;
    s.minimized = false;
    if(windowEl) windowEl.style.display = 'flex';
    state.copilotActive = true;
    saveSettings();
    _syncLauncher();
    restoreScrollPosition();
    bringWindowToFront();
    _applyMobileMode();
}

// v2.10.0: sync launcher state + mobile mode via lazy import (avoid circular deps).
function _syncLauncher() {
    import('./ui-launcher.js').then(m => m.refreshLauncher()).catch(() => {});
}
function _applyMobileMode() {
    import('./ui-launcher.js').then(m => m.applyMobileMode()).catch(() => {});
}

export function toggleVisibility() {
    const s = getSettings();
    if (!s.windowVisible || s.minimized) { showWindow(); return; }
    if (s.floatingIconPersistent) { hideWindow(); } else { minimize(); }
}
