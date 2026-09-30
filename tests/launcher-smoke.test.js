// Smoke-тест лаунчеров: монтирование кнопки в qr--bar и FAB по режиму launcherMode.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSettings, saveSettings } from '../src/session.js';
import { ensureLauncher, refreshLauncher, ensureFloatingIcon } from '../src/ui/ui-launcher.js';
import { WIN_ID, ICON_ID } from '../src/constants.js';

vi.mock('../src/state.js', () => ({ state: {}, invalidateSystemPromptCache: () => {} }));
// util-debug тянет index.js (циклическая зависимость) — замокаем целиком.
vi.mock('../src/utils/util-debug.js', () => ({
    _dbgAdd: () => {},
    _dbgDiffSettings: () => {},
}));

beforeEach(() => {
    document.body.innerHTML = '';
    // ST quick-reply bar хост
    const sendForm = document.createElement('div');
    sendForm.id = 'send_form';
    sendForm.innerHTML = '<div id="qr--bar"><div class="qr--buttons"></div></div>';
    document.body.appendChild(sendForm);
    // окно
    const win = document.createElement('div');
    win.id = WIN_ID;
    win.style.display = 'none';
    document.body.appendChild(win);
    localStorage.clear();
    const s = getSettings();
    s.enabled = true;
    s.windowVisible = false;
    s.minimized = false;
    saveSettings();
});

describe('launcherMode', () => {
    it('bar: только кнопка в qr--bar, без FAB', () => {
        const s = getSettings();
        s.launcherMode = 'bar';
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        expect(document.getElementById('scp-launcher')).toBeTruthy();
        expect(document.getElementById(ICON_ID)).toBeNull();
    });

    it('floating: только FAB, без кнопки в баре', () => {
        const s = getSettings();
        s.launcherMode = 'floating';
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        expect(document.getElementById('scp-launcher')).toBeNull();
        const icon = document.getElementById(ICON_ID);
        expect(icon).toBeTruthy();
        // окно скрыто → FAB показана
        expect(icon.style.display).not.toBe('none');
    });

    it('both: и кнопка, и FAB', () => {
        const s = getSettings();
        s.launcherMode = 'both';
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        expect(document.getElementById('scp-launcher')).toBeTruthy();
        expect(document.getElementById(ICON_ID)).toBeTruthy();
    });

    it('FAB скрывается, когда окно открыто', () => {
        const s = getSettings();
        s.launcherMode = 'floating';
        s.windowVisible = true;
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        const icon = document.getElementById(ICON_ID);
        expect(icon).toBeTruthy();
        expect(icon.style.display).toBe('none');
    });

    it('FAB скрывается при отключённом расширении', () => {
        const s = getSettings();
        s.launcherMode = 'both';
        s.enabled = false;
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        expect(document.getElementById('scp-launcher')).toBeNull();
        expect(document.getElementById(ICON_ID)).toBeNull();
    });

    it('переключение режима убирает старую кнопку и ставит FAB', () => {
        const s = getSettings();
        s.launcherMode = 'bar';
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        expect(document.getElementById('scp-launcher')).toBeTruthy();

        s.launcherMode = 'floating';
        saveSettings();
        ensureLauncher({ onToggle: () => {} });
        expect(document.getElementById('scp-launcher')).toBeNull();
        expect(document.getElementById(ICON_ID)).toBeTruthy();
    });

    it('refreshLauncher не падает без элементов', () => {
        expect(() => refreshLauncher()).not.toThrow();
        expect(() => ensureFloatingIcon()).not.toThrow();
    });
});
