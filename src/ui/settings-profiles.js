// Settings: configuration profiles (save/load/bindings), the dirty-state
// tracking shared by profiles and themes, and the theme editor. Split out of
// ui-settings.js; registry/engine functions are imported from the sibling
// submodules directly, not through the facade.
import { THEME_PRESETS, THEME_VAR_DEFS, THEME_CSS_MAP, EXT_DISPLAY, DEFAULT_SYSTEM_PROMPT } from '../constants.js';
import { state } from '../state.js';
import { getSettings, saveSettings, getEffectiveSettings, setSessionOverride, getBindingKey } from '../session.js';
import { showCustomDialog, escHtml } from '../utils/util-dom.js';
import { applyCustomTheme } from './ui-window.js';
import { showColorPicker } from '../utils/util-colorpicker.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { _PROFILE_KEYS } from './settings-defs.js';
import { updateSettingsUI, _pruneMatchingOverrides } from './settings-core.js';
// ─── Configuration Profiles ───────────────────────────────────────────────────

let _profileSnapshot = null;

export function _takeProfileSnapshot() {
    const s = getSettings();
    _profileSnapshot = {};
    for (const k of _PROFILE_KEYS) _profileSnapshot[k] = JSON.stringify(s[k]);
    _profileSnapshot._charEditFields = JSON.stringify(s.charEditFields || {});
}

export function isConfigProfileDirty() {
    if (!_profileSnapshot) return false;
    const s = getSettings();
    for (const k of _PROFILE_KEYS) { if (JSON.stringify(s[k]) !== _profileSnapshot[k]) return true; }
    if (JSON.stringify(s.charEditFields || {}) !== _profileSnapshot._charEditFields) return true;
    return false;
}

export function _markDirty(type) {
    if (type === 'config') state.configDirty = isConfigProfileDirty();
    if (type === 'theme') state.themeDirty = isThemeDirty();
    _updateDirtyDots();
}

export function _clearDirty(type) {
    if (type === 'config') { state.configDirty = false; _takeProfileSnapshot(); }
    if (type === 'theme') state.themeDirty = false;
    _updateDirtyDots();
}

export function _updateDirtyDots() {
    const dot = '<span class="scp-save-dirty-dot"></span>';
    ['scp-profile-save', 'scp-sp-profile-save'].forEach(id => {
        const btn = document.getElementById(id); if (!btn) return;
        btn.querySelectorAll('.scp-save-dirty-dot').forEach(d => d.remove());
        if (state.configDirty) btn.insertAdjacentHTML('beforeend', dot);
    });
    document.querySelectorAll('#scp-theme-save').forEach(btn => {
        btn.querySelectorAll('.scp-save-dirty-dot').forEach(d => d.remove());
        if (state.themeDirty) btn.insertAdjacentHTML('beforeend', dot);
    });
}

export function saveProfile(name) {
    const s = getSettings(); const p = {};
    for (const k of _PROFILE_KEYS) p[k] = s[k];
    p.charEditFields = JSON.parse(JSON.stringify(s.charEditFields || {}));
    s.profiles[name] = p; s.activeProfile = name; saveSettings();
}

export function loadProfile(name) {
    const s = getSettings(); const p = s.profiles[name]; if (!p) return;
    for (const k of _PROFILE_KEYS) { if (p[k] !== undefined) s[k] = p[k]; }
    if (p.charEditFields) s.charEditFields = JSON.parse(JSON.stringify(p.charEditFields));
    s.activeProfile = name; saveSettings();
    if (typeof updateSettingsUI === 'function') updateSettingsUI();
    _takeProfileSnapshot(); state.configDirty = false; _updateDirtyDots();
    _pruneMatchingOverrides();
}

export function deleteProfile(name) {
    const s = getSettings(); delete s.profiles[name];
    if (s.activeProfile === name) s.activeProfile = '';
    for (const k in s.profileBindings) { if (s.profileBindings[k] === name) delete s.profileBindings[k]; }
    saveSettings();
}

export function refreshProfilesDropdown() {
    const sel = document.getElementById('scp-profile-select'); if (!sel) return;
    const s = getSettings();
    if (!Object.keys(s.profiles).length) {
        s.profiles['Default'] = { systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true, includeAuthorsNote: true, includeCharacterCard: true, includeUserPersonality: true, contextDepth: 15, localHistoryLimit: 50, connectionSource: 'default', connectionProfileId: '', maxTokens: 8200, applyRegexToContext: true };
        s.activeProfile = 'Default'; saveSettings();
    }
    sel.innerHTML = ''; let hasActive = false;
    for (const name of Object.keys(s.profiles)) {
        const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
        if (name === s.activeProfile) { opt.selected = true; hasActive = true; }
        sel.appendChild(opt);
    }
    if (!hasActive && Object.keys(s.profiles).length > 0) { loadProfile(Object.keys(s.profiles)[0]); sel.value = Object.keys(s.profiles)[0]; }
    updateBindingSection();
}

export function updateBindingSection() {
    const sel = document.getElementById('scp-profile-select');
    const section = document.getElementById('scp-binding-section');
    if (!section) return;
    section.style.display = sel?.value ? '' : 'none'; if (!sel?.value) return;
    const s = getSettings(); const { charId, chatId } = getBindingKey();
    document.getElementById('scp-bind-char')?.classList.toggle('active', s.profileBindings[`char_${charId}`] === sel.value);
    document.getElementById('scp-bind-chat')?.classList.toggle('active', s.profileBindings[`chat_${charId}_${chatId}`] === sel.value);
}

export function autoLoadBoundProfile() {
    const s = getSettings(); const { charId, chatId } = getBindingKey();
    const name = s.profileBindings[`chat_${charId}_${chatId}`] || s.profileBindings[`char_${charId}`];
    if (name && s.profiles[name]) { loadProfile(name); const sel = document.getElementById('scp-profile-select'); if (sel) sel.value = name; }
    else if (name && !s.profiles[name]) _dbgAdd('PROFILE_LOAD_BINDING_MISSING', { name });
}

export async function updateProfilesList() {
    const profSel = document.getElementById('scp-conn-profile'); if (!profSel) return;
    const ctx = SillyTavern.getContext(); const s = getSettings(); let currentVal = s.connectionProfileId || '';
    const service = ctx.ConnectionManagerRequestService;
    let profiles = service?.getSupportedProfiles?.() ?? ctx.extensionSettings?.connectionManager?.profiles ?? [];
    if (currentVal && !profiles.some(p => p.id === currentVal)) {
        _dbgAdd('PROFILE_GHOST_CLEANUP', { removedId: currentVal });
        s.connectionProfileId = '';
        // Не оставляем мину: source='profile' с пустым id — гарантированный
        // hard error на каждой генерации. Откат на текущий API ST с уведомлением.
        if (s.connectionSource === 'profile') s.connectionSource = 'default';
        saveSettings(); currentVal = '';
        toastr.warning('Сохранённый профиль подключения не найден — Copilot переключён на текущий API SillyTavern.', EXT_DISPLAY);
    }
    if (service?.handleDropdown) { service.handleDropdown(profSel); if (currentVal && Array.from(profSel.options).some(o => o.value === currentVal)) profSel.value = currentVal; return; }
    profSel.innerHTML = '<option value="">-- Выберите профиль --</option>';
    profiles.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; profSel.appendChild(o); });
    if (Array.from(profSel.options).some(o => o.value === currentVal)) profSel.value = currentVal;
}

export async function updateSPConnProfileList() {
    const selIds = ['scp-sp-conn-profile', 'scp-sp-ov-conn-profile'];
    const s = getSettings(); const eff = getEffectiveSettings();
    const ctx = SillyTavern.getContext(); const service = ctx.ConnectionManagerRequestService;
    let profiles = service?.getSupportedProfiles?.() ?? ctx.extensionSettings?.connectionManager?.profiles ?? [];
    selIds.forEach(sid => {
        const sel = document.getElementById(sid); if (!sel) return;
        const isOv = sid === 'scp-sp-ov-conn-profile';
        let targetVal = isOv ? (eff.connectionProfileId || '') : (s.connectionProfileId || '');
        if (targetVal && !profiles.some(p => p.id === targetVal)) {
            if (isOv) {
                setSessionOverride('connectionProfileId', undefined);
            } else {
                s.connectionProfileId = '';
                if (s.connectionSource === 'profile') s.connectionSource = 'default';
                saveSettings();
            }
            targetVal = '';
        }
        sel.innerHTML = '<option value="">-- Выберите профиль --</option>';
        profiles.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
        if (Array.from(sel.options).some(o => o.value === targetVal)) sel.value = targetVal;
    });
}

export function refreshSPProfilesDropdown() {
    const sel = document.getElementById('scp-sp-profile-select'); if (!sel) return;
    const s = getSettings();
    if (!Object.keys(s.profiles).length) {
        s.profiles['Default'] = { systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true, includeAuthorsNote: true, includeCharacterCard: true, includeUserPersonality: true, contextDepth: 15, localHistoryLimit: 50, connectionSource: 'default', connectionProfileId: '', maxTokens: 8200, applyRegexToContext: true };
        s.activeProfile = 'Default'; saveSettings();
    }
    sel.innerHTML = '';
    for (const name of Object.keys(s.profiles)) {
        const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
        if (name === s.activeProfile) opt.selected = true;
        sel.appendChild(opt);
    }
    updateSPBindingSection();
}

export function updateSPBindingSection() {
    const sel = document.getElementById('scp-sp-profile-select');
    const section = document.getElementById('scp-sp-binding-section');
    if (!section) return;
    section.style.display = sel?.value ? '' : 'none'; if (!sel?.value) return;
    const s = getSettings(); const { charId, chatId } = getBindingKey();
    document.getElementById('scp-sp-bind-char')?.classList.toggle('active', s.profileBindings[`char_${charId}`] === sel.value);
    document.getElementById('scp-sp-bind-chat')?.classList.toggle('active', s.profileBindings[`chat_${charId}_${chatId}`] === sel.value);
}

// ─── Theme Editor ─────────────────────────────────────────────────────────────

const _COLOR_KEYS = new Set(['bg','text','textMuted','accent','accentDim','accentBg','headerBg','toolbarBg','msgUserBg','msgAiBg','inputBg','codeBg','danger','success']);

export function isThemeDirty() {
    const s = getSettings(); const current = s.customTheme || {};
    if (s.activeThemeProfile && s.savedThemes[s.activeThemeProfile]) {
        const saved = s.savedThemes[s.activeThemeProfile];
        return THEME_VAR_DEFS.some(def => (current[def.key] || '') !== (saved[def.key] || ''));
    }
    for (const preset of Object.values(THEME_PRESETS)) {
        if (THEME_VAR_DEFS.every(def => (current[def.key] || '') === (preset[def.key] || ''))) return false;
    }
    return true;
}

export function buildThemeEditor(containerOverride) {
    const container = containerOverride || document.getElementById('scp-theme-section'); if (!container) return;
    container.innerHTML = '';
    const s = getSettings();
    if (!s.savedThemes || !Object.keys(s.savedThemes).length) {
        s.savedThemes = { 'Default': { ...THEME_PRESETS.default } }; s.activeThemeProfile = 'Default';
        s.customTheme = { ...s.savedThemes['Default'] }; saveSettings();
    }
    const profileRow = document.createElement('div'); profileRow.className = 'scp-profile-bar'; profileRow.style.marginBottom = '12px';
    profileRow.innerHTML = `
        <select id="scp-theme-profile-select"></select>
        <button class="scp-profile-icon-btn" id="scp-theme-save" title="Сохранить текущую тему"><i class="fa-solid fa-floppy-disk"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-create" title="Создать новую тему"><i class="fa-solid fa-plus"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-duplicate" title="Дублировать тему"><i class="fa-solid fa-copy"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-rename" title="Переименовать тему"><i class="fa-solid fa-pen"></i></button>
        <button class="scp-profile-icon-btn danger" id="scp-theme-delete" title="Удалить тему"><i class="fa-solid fa-trash"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-export" title="Экспорт темы"><i class="fa-solid fa-file-export"></i></button>
        <button class="scp-profile-icon-btn" id="scp-theme-import" title="Импорт темы"><i class="fa-solid fa-file-import"></i></button>`;
    container.appendChild(profileRow);
    const sel = profileRow.querySelector('#scp-theme-profile-select');
    const optGrpDefault = document.createElement('optgroup'); optGrpDefault.label = 'Пресеты по умолчанию';
    for (const [key, preset] of Object.entries(THEME_PRESETS)) {
        const opt = document.createElement('option'); opt.value = `__preset__${key}`; opt.textContent = preset.label; optGrpDefault.appendChild(opt);
    }
    sel.appendChild(optGrpDefault);
    const userKeys = Object.keys(s.savedThemes);
    if (userKeys.length) {
        const optGrpCustom = document.createElement('optgroup'); optGrpCustom.label = 'Пользовательские темы';
        for (const name of userKeys) {
            const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
            if (name === s.activeThemeProfile) opt.selected = true;
            optGrpCustom.appendChild(opt);
        }
        sel.appendChild(optGrpCustom);
    }
    if (!s.activeThemeProfile || !s.savedThemes[s.activeThemeProfile]) {
        const matchKey = Object.keys(THEME_PRESETS).find(k => THEME_VAR_DEFS.every(d => (s.customTheme?.[d.key] || '') === (THEME_PRESETS[k][d.key] || '')));
        if (matchKey) sel.value = `__preset__${matchKey}`;
    }
    sel.addEventListener('change', async () => {
        const name = sel.value;
        if (isThemeDirty()) {
            const ok = await showCustomDialog({ type: 'confirm', title: 'Несохранённые изменения', message: 'У вас есть несохранённые изменения. Переключиться всё равно?' });
            if (!ok) { sel.value = s.activeThemeProfile ? s.activeThemeProfile : sel.value; return; }
        }
        const s2 = getSettings();
        if (name.startsWith('__preset__')) {
            s2.customTheme = { ...THEME_PRESETS[name.replace('__preset__', '')] }; s2.activeThemeProfile = '';
        } else if (s2.savedThemes[name]) {
            s2.customTheme = { ...s2.savedThemes[name] }; s2.activeThemeProfile = name;
        }
        saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride);
    });
    profileRow.querySelector('#scp-theme-save').addEventListener('click', async () => {
        const val = sel.value;
        if (val.startsWith('__preset__')) {
            const name = await showCustomDialog({ type: 'prompt', title: 'Сохранить как пользовательскую тему', message: 'Название для вашей пользовательской темы:', placeholder: 'Моя тема' });
            if (!name?.trim()) return;
            const s2 = getSettings(); s2.savedThemes[name.trim()] = { ...s2.customTheme }; s2.activeThemeProfile = name.trim(); saveSettings(); buildThemeEditor(containerOverride); toastr.success(`Тема "${name.trim()}" сохранена`, EXT_DISPLAY); _clearDirty('theme');
        } else if (val) {
            const s2 = getSettings(); s2.savedThemes[val] = { ...s2.customTheme }; saveSettings(); toastr.success(`Тема "${val}" обновлена`, EXT_DISPLAY); _clearDirty('theme');
        }
    });
    profileRow.querySelector('#scp-theme-create').addEventListener('click', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'Новая тема', message: 'Введите название новой темы:', placeholder: 'Моя новая тема' });
        if (!name?.trim()) return;
        const s2 = getSettings(); s2.savedThemes[name.trim()] = { ...s2.customTheme }; s2.activeThemeProfile = name.trim(); saveSettings(); buildThemeEditor(containerOverride); toastr.success(`Создана тема "${name.trim()}"`, EXT_DISPLAY);
    });
    profileRow.querySelector('#scp-theme-duplicate').addEventListener('click', async () => {
        const val = sel.value; if (!val) return;
        const baseTheme = val.startsWith('__preset__') ? THEME_PRESETS[val.replace('__preset__', '')] : s.savedThemes[val]; if (!baseTheme) return;
        const defaultName = (val.startsWith('__preset__') ? THEME_PRESETS[val.replace('__preset__', '')].label : val) + ' (Копия)';
        const name = await showCustomDialog({ type: 'prompt', title: 'Дублировать тему', message: 'Название для дублированной темы:', defaultValue: defaultName });
        if (!name?.trim()) return;
        const s2 = getSettings(); s2.savedThemes[name.trim()] = JSON.parse(JSON.stringify(baseTheme)); s2.activeThemeProfile = name.trim(); s2.customTheme = { ...s2.savedThemes[name.trim()] };
        saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride); toastr.success(`Тема дублирована как "${name.trim()}"`, EXT_DISPLAY);
    });
    profileRow.querySelector('#scp-theme-rename').addEventListener('click', async () => {
        const val = sel.value; if (!val || val.startsWith('__preset__')) { toastr.info('Выберите пользовательскую тему для переименования.', EXT_DISPLAY); return; }
        const newName = await showCustomDialog({ type: 'prompt', title: 'Переименовать тему', message: 'Введите новое название:', defaultValue: val });
        if (!newName?.trim() || newName.trim() === val) return;
        const s2 = getSettings(); s2.savedThemes[newName.trim()] = s2.savedThemes[val]; delete s2.savedThemes[val]; s2.activeThemeProfile = newName.trim(); saveSettings(); buildThemeEditor(containerOverride); toastr.success('Тема переименована.', EXT_DISPLAY);
    });
    profileRow.querySelector('#scp-theme-delete').addEventListener('click', async () => {
        const val = sel.value; if (!val || val.startsWith('__preset__')) { toastr.info('Выберите пользовательскую тему для удаления.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить тему', message: `Удалить "${val}"?` }); if (!ok) return;
        const s2 = getSettings(); delete s2.savedThemes[val]; s2.activeThemeProfile = Object.keys(s2.savedThemes)[0] || '';
        s2.customTheme = s2.activeThemeProfile ? { ...s2.savedThemes[s2.activeThemeProfile] } : { ...THEME_PRESETS.default };
        saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride); toastr.success('Удалено.', EXT_DISPLAY);
    });
    profileRow.querySelector('#scp-theme-export').addEventListener('click', () => {
        const s2 = getSettings(); const val = sel.value;
        const rawName = val.startsWith('__preset__') ? val.replace('__preset__', '') : (val || 'custom');
        const blob = new Blob([JSON.stringify({ name: rawName, version: 1, theme: s2.customTheme }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `st-copilot-theme-${rawName.replace(/[^a-z0-9]/gi, '_')}.json`; a.click(); URL.revokeObjectURL(a.href);
    });
    profileRow.querySelector('#scp-theme-import').addEventListener('click', () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.onchange = async () => {
            const file = inp.files?.[0]; if (!file) return;
            try {
                const data = JSON.parse(await file.text()); const imported = data.theme || data;
                if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Invalid format');
                const themeName = (data.name && typeof data.name === 'string') ? data.name : file.name.replace(/\.json$/i, '');
                const s2 = getSettings(); s2.savedThemes[themeName] = { ...THEME_PRESETS.default, ...imported }; s2.activeThemeProfile = themeName; s2.customTheme = { ...s2.savedThemes[themeName] };
                saveSettings(); applyCustomTheme(s2.customTheme); buildThemeEditor(containerOverride); toastr.success(`Тема "${escHtml(themeName)}" импортирована.`, EXT_DISPLAY);
            } catch (e) { toastr.error('Неверный файл темы.', EXT_DISPLAY); }
        };
        inp.click();
    });
    const grid = document.createElement('div'); grid.className = 'scp-theme-var-grid';
    const windowEl = document.getElementById('scp-window');
    for (const def of THEME_VAR_DEFS) {
        const item = document.createElement('div'); item.className = 'scp-theme-var-item';
        const label = document.createElement('div'); label.className = 'scp-theme-var-label'; label.textContent = def.label;
        const wrap = document.createElement('div'); wrap.className = 'scp-theme-var-wrap';
        const isColorKey = _COLOR_KEYS.has(def.key); const isFontKey = def.key === 'font' || def.key === 'fontSize';
        const preview = document.createElement('div'); preview.className = 'scp-theme-var-preview';
        let curVal = s.customTheme?.[def.key] ?? '';
        if (def.key === 'fontSize' && /^\d+$/.test(curVal)) curVal += 'px';
        if (isColorKey) { preview.style.background = curVal; preview.style.display = curVal ? '' : 'none'; preview.classList.add('scp-color-clickable'); }
        else { preview.style.display = 'none'; }
        const input = document.createElement('input'); input.type = 'text'; input.className = 'scp-theme-var-input'; input.value = curVal; input.placeholder = def.hint; input.dataset.key = def.key;
        const cssVar = THEME_CSS_MAP[def.key];
        const getDefaultVal = () => {
            const ss = getSettings();
            if (ss.activeThemeProfile && ss.savedThemes?.[ss.activeThemeProfile]) return ss.savedThemes[ss.activeThemeProfile][def.key] ?? '';
            const selEl = container.querySelector('#scp-theme-profile-select'); const selVal = selEl?.value || '';
            if (selVal.startsWith('__preset__')) return (THEME_PRESETS[selVal.replace('__preset__', '')] || THEME_PRESETS.default)[def.key] ?? '';
            return THEME_PRESETS.default[def.key] ?? '';
        };
        const resetBtn = document.createElement('button'); resetBtn.className = 'scp-theme-var-reset'; resetBtn.title = 'Сбросить к значению профиля по умолчанию'; resetBtn.textContent = '↺';
        const updateResetState = val => { resetBtn.disabled = !val || val === getDefaultVal(); };
        updateResetState(curVal);
        let _fontDebounce = null;
        let _saveDebounce = null;
        const applyVal = val => {
            const s2 = getSettings(); if (!s2.customTheme) s2.customTheme = {};
            s2.customTheme[def.key] = val; _markDirty('theme');
            clearTimeout(_saveDebounce);
            _saveDebounce = setTimeout(() => saveSettings(), 300);
            document.querySelectorAll(`input.scp-theme-var-input[data-key="${def.key}"]`).forEach(inp => { if (inp.value !== val) inp.value = val; });
            if (isColorKey) {
                if (cssVar) [windowEl, document.getElementById('scp-lb-overlay'), document.getElementById('scp-diff-modal')].filter(Boolean).forEach(t => t.style.setProperty(cssVar, val));
                preview.style.background = val; preview.style.display = val ? '' : 'none';
            } else if (isFontKey) {
                clearTimeout(_fontDebounce);
                _fontDebounce = setTimeout(() => {
                    let fVal = val.trim(); if (def.key === 'fontSize' && /^\d+$/.test(fVal)) fVal += 'px';
                    const targets = [windowEl, document.getElementById('scp-lb-overlay'), document.getElementById('scp-diff-modal'), document.getElementById('scp-settings-overlay'), document.getElementById('scp-picker-overlay')].filter(Boolean);
                    targets.forEach(t => { if (fVal) { t.style.setProperty(cssVar, fVal); if (def.key === 'fontSize') t.style.fontSize = fVal; } else { t.style.removeProperty(cssVar); if (def.key === 'fontSize') t.style.fontSize = ''; } });
                }, 600);
            } else {
                if (cssVar) [windowEl, document.getElementById('scp-lb-overlay'), document.getElementById('scp-diff-modal')].filter(Boolean).forEach(t => t.style.setProperty(cssVar, val));
            }
            updateResetState(val);
        };
        input.addEventListener('input', () => applyVal(input.value));
        resetBtn.addEventListener('click', () => applyVal(getDefaultVal() || ''));
        if (isColorKey) preview.addEventListener('click', () => showColorPicker(preview, input.value || '#7c6dfa', val => applyVal(val)));
        wrap.appendChild(preview); wrap.appendChild(input); wrap.appendChild(resetBtn);
        item.appendChild(label); item.appendChild(wrap); grid.appendChild(item);
    }
    container.appendChild(grid);
}
