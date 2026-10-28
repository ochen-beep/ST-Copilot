// Settings panel: overlay open/close, the setup functions wiring all panel and
// ST-drawer listeners, and the quick-prompts settings list. Split out of
// ui-settings.js; registry/engine/profiles functions are imported from the
// sibling submodules directly, not through the facade.
import { THEME_PRESETS, EXT_DISPLAY, DEFAULT_SYSTEM_PROMPT, DEFAULT_CHAR_EDIT_DIRECTIVE, DEFAULT_LB_MANAGE_PROMPT, DEFAULT_CHAT_EDIT_DIRECTIVE, DEFAULT_TOOLS_PROMPT, DEFAULT_MEMORY_PROMPT, I } from '../constants.js';
import { getSettings, saveSettings, getBindingKey, hasSessionOverrides, setSessionOverride, clearAllSessionOverrides, getCurrentSession, initChatBucket, deleteSessionFile } from '../session.js';
import { showCustomDialog } from '../utils/util-dom.js';
import { bringWindowToFront } from './ui-window.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { _CE_FIELDS_DEF } from './settings-defs.js';
import { _bindAllSettings, syncOverlayUI, syncSPFromSettings, updateSettingsUI, updateSPOverrideIndicators, updateSessionOverrideIndicator, _syncOvToGlobal, _resetOvElToEffective } from './settings-core.js';
import { _markDirty, _clearDirty, _updateDirtyDots, isConfigProfileDirty, loadProfile, saveProfile, deleteProfile, refreshProfilesDropdown, refreshSPProfilesDropdown, updateBindingSection, updateSPBindingSection, buildThemeEditor } from './settings-profiles.js';
// ─── Panel Open/Close ─────────────────────────────────────────────────────────

export function openSettingsPanel() {
    const overlay = document.getElementById('scp-settings-overlay'); if (!overlay) return;
    import('./ui-window.js').then(m => m.applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default));
    syncSPFromSettings(); buildThemeEditor(document.getElementById('scp-sp-theme-section')); _updateDirtyDots();
    import('./ui-widgets.js').then(mod => {
        mod.buildSoundSettingsUI(document.getElementById('scp-sp-sound-settings'));
        buildQPSettingsUI(document.getElementById('scp-sp-qp-container'));
        mod.buildQPSetManager(document.getElementById('scp-sp-qp-set-manager'), () => buildQPSettingsUI(document.getElementById('scp-sp-qp-container')));
        const mkPresetMgr = (containerId, getTextId, dictKey) => mod.buildPromptPresetManager(
            document.getElementById(containerId),
            () => document.getElementById(getTextId)?.value || '',
            text => { const ta = document.getElementById(getTextId); if (ta) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); } },
            dictKey
        );
        mkPresetMgr('scp-sp-prompt-preset-manager',      'scp-sp-ov-sysprompt',       undefined);
        mkPresetMgr('scp-sp-ov-char-preset-manager',     'scp-sp-ov-char-edit-prompt', 'charEditPromptPresets');
        mkPresetMgr('scp-sp-ov-lb-preset-manager',       'scp-sp-ov-lb-manage-prompt', 'lbEditPromptPresets');
        mkPresetMgr('scp-sp-ov-chat-preset-manager',     'scp-sp-ov-chat-edit-prompt', 'chatEditPromptPresets');
    }).catch(() => {});
    import('../features/feature-character-ui.js').then(m => m.refreshAltGreetingsPickers());
    overlay.style.display = 'flex'; updateSessionOverrideIndicator();
    bringWindowToFront();
    import('../features/feature-memory.js').then(m => m.updateMemoryDot());
    overlay.querySelectorAll('.scp-sp-tab').forEach(t => t.classList.toggle('active', t.dataset.sptab === 'global'));
    overlay.querySelectorAll('.scp-sp-tab-pane').forEach(p => { p.style.display = p.id === 'scp-sp-pane-global' ? '' : 'none'; });
}

export function closeSettingsPanel() {
    const overlay = document.getElementById('scp-settings-overlay'); if (overlay) overlay.style.display = 'none';
}

// ─── Main Setup Functions ─────────────────────────────────────────────────────

export function setupSettingsHandlers() {
    _bindAllSettings();

    // ── forceStreaming button group ──
    document.querySelectorAll('#scp-st-stream-auto, #scp-st-stream-on, #scp-st-stream-off').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.stream; getSettings().forceStreaming = val; saveSettings();
            syncOverlayUI('forceStreaming', val); _markDirty('config');
        });
    });

    // ── Reset buttons ──
    const _resetPrompt = async (key, defaultVal, stId, spId, label) => {
        const ok = await showCustomDialog({ type: 'confirm', title: `Сбросить ${label}`, message: `Сбросить к значению по умолчанию?` }); if (!ok) return;
        getSettings()[key] = defaultVal === '' ? '' : undefined; if (defaultVal !== '') getSettings()[key] = defaultVal;
        saveSettings(); _markDirty('config');
        const displayVal = defaultVal || (key === 'charEditPrompt' ? DEFAULT_CHAR_EDIT_DIRECTIVE.trim() : key === 'chatEditPrompt' ? DEFAULT_CHAT_EDIT_DIRECTIVE.trim() : key === 'lorebookManagePrompt' ? DEFAULT_LB_MANAGE_PROMPT : key === 'memoryManagePrompt' ? DEFAULT_MEMORY_PROMPT : DEFAULT_SYSTEM_PROMPT);
        [stId, spId].forEach(id => { const el = document.getElementById(id); if (el) el.value = displayVal; });
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
        toastr.success(`${label} сброшен.`, EXT_DISPLAY);
    };
    document.getElementById('scp-reset-prompt')?.addEventListener('click', () => _resetPrompt('systemPrompt', DEFAULT_SYSTEM_PROMPT, 'scp-sysprompt', 'scp-sp-sysprompt', 'Системный промпт'));
    document.getElementById('scp-reset-char-edit-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт редактирования персонажа', message: 'Сбросить к встроенному значению по умолчанию?' }); if (!ok) return;
        getSettings().charEditPrompt = ''; saveSettings(); _markDirty('config');
        ['scp-char-edit-prompt', 'scp-sp-char-edit-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_CHAR_EDIT_DIRECTIVE.trim(); });
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession())); toastr.success('Промпт редактирования персонажа сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-reset-lb-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт лорбука', message: 'Сбросить к значению по умолчанию?' }); if (!ok) return;
        getSettings().lorebookManagePrompt = DEFAULT_LB_MANAGE_PROMPT; saveSettings();
        ['scp-lb-manage-prompt', 'scp-sp-lb-manage-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_LB_MANAGE_PROMPT; });
        toastr.success('Промпт лорбука сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-reset-memory-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт', message: 'Сбросить промпт памяти к значению по умолчанию?' }); if (!ok) return;
        getSettings().memoryManagePrompt = DEFAULT_MEMORY_PROMPT; saveSettings();
        ['scp-memory-prompt', 'scp-sp-memory-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_MEMORY_PROMPT; });
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession())); toastr.success('Промпт сброшен.', EXT_DISPLAY);
    });

    // ── Profile management (ST drawer) ──
    document.getElementById('scp-profile-select')?.addEventListener('change', async () => {
        const sel = document.getElementById('scp-profile-select'); const name = sel.value;
        if (isConfigProfileDirty()) {
            const ok = await showCustomDialog({ type: 'confirm', title: 'Несохранённая конфигурация', message: 'У вас есть несохранённые изменения. Переключиться всё равно?' });
            if (!ok) { sel.value = getSettings().activeProfile || ''; return; }
        }
        if (name) loadProfile(name); updateBindingSection();
    });
    document.getElementById('scp-profile-save')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-profile-select'); let name = sel?.value;
        if (!name) { name = await showCustomDialog({ type: 'prompt', title: 'Сохранить конфигурацию', message: 'Введите название для этой конфигурации:', placeholder: 'Моя конфигурация' }); if (!name?.trim()) return; name = name.trim(); }
        saveProfile(name); refreshProfilesDropdown(); if (sel) sel.value = name;
        updateBindingSection(); toastr.success(`Сохранено "${name}"`, EXT_DISPLAY); _clearDirty('config');
    });
    document.getElementById('scp-profile-create-new')?.addEventListener('click', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'Новая конфигурация', message: 'Введите название для нового профиля по умолчанию:', placeholder: 'Новая конфигурация' }); if (!name?.trim()) return;
        const n = name.trim(); const s = getSettings();
        s.profiles[n] = { systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true, includeAuthorsNote: true, includeCharacterCard: true, includeUserPersonality: true, contextDepth: 15, localHistoryLimit: 50, connectionSource: 'default', connectionProfileId: '', maxTokens: 8200 };
        saveSettings(); refreshProfilesDropdown(); loadProfile(n);
        const sel = document.getElementById('scp-profile-select'); if (sel) sel.value = n;
        updateBindingSection(); toastr.success(`Создано "${n}"`, EXT_DISPLAY);
    });
    document.getElementById('scp-profile-duplicate')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-profile-select'); if (!sel?.value) return toastr.info('Конфигурация не выбрана.', EXT_DISPLAY);
        const newName = await showCustomDialog({ type: 'prompt', title: 'Дублировать конфигурацию', message: 'Название для нового профиля:', defaultValue: sel.value + ' (Копия)' }); if (!newName?.trim()) return;
        const n = newName.trim(); const s = getSettings(); const p = s.profiles[sel.value]; if (!p) return;
        s.profiles[n] = JSON.parse(JSON.stringify(p)); saveSettings(); refreshProfilesDropdown(); refreshSPProfilesDropdown(); loadProfile(n);
        const newSel = document.getElementById('scp-profile-select'); if (newSel) newSel.value = n;
        updateBindingSection(); toastr.success(`Дублировано как "${n}"`, EXT_DISPLAY);
    });
    document.getElementById('scp-profile-rename')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-profile-select'); if (!sel?.value) return toastr.info('Конфигурация не выбрана.', EXT_DISPLAY);
        const newName = await showCustomDialog({ type: 'prompt', title: 'Переименовать конфигурацию', message: 'Новое название:', defaultValue: sel.value }); if (!newName?.trim() || newName.trim() === sel.value) return;
        const s = getSettings(); const p = s.profiles[sel.value]; if (!p) return;
        s.profiles[newName.trim()] = p; delete s.profiles[sel.value];
        if (s.activeProfile === sel.value) s.activeProfile = newName.trim();
        for (const k in s.profileBindings) { if (s.profileBindings[k] === sel.value) s.profileBindings[k] = newName.trim(); }
        saveSettings(); refreshProfilesDropdown();
        const newSel = document.getElementById('scp-profile-select'); if (newSel) newSel.value = newName.trim();
        updateBindingSection(); toastr.success('Переименовано.', EXT_DISPLAY);
    });
    document.getElementById('scp-profile-delete')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); if (Object.keys(s.profiles).length <= 1) { toastr.warning('Невозможно удалить последний оставшийся профиль конфигурации.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить конфигурацию', message: `Удалить "${sel.value}"?` }); if (!ok) return;
        deleteProfile(sel.value); refreshProfilesDropdown(); updateBindingSection(); toastr.success('Удалено.', EXT_DISPLAY);
    });
    document.getElementById('scp-bind-char')?.addEventListener('click', () => {
        const sel = document.getElementById('scp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); const { charId } = getBindingKey(); const key = `char_${charId}`;
        if (s.profileBindings[key] === sel.value) delete s.profileBindings[key]; else s.profileBindings[key] = sel.value;
        _dbgAdd(s.profileBindings[key] ? 'PROFILE_BIND' : 'PROFILE_UNBIND', { target: 'char', profile: sel.value }); saveSettings(); updateBindingSection();
    });
    document.getElementById('scp-bind-chat')?.addEventListener('click', () => {
        const sel = document.getElementById('scp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); const { charId, chatId } = getBindingKey(); const key = `chat_${charId}_${chatId}`;
        if (s.profileBindings[key] === sel.value) delete s.profileBindings[key]; else s.profileBindings[key] = sel.value;
        _dbgAdd(s.profileBindings[key] ? 'PROFILE_BIND' : 'PROFILE_UNBIND', { target: 'chat', profile: sel.value }); saveSettings(); updateBindingSection();
    });

    // ── Misc buttons ──
    document.getElementById('scp-open-window')?.addEventListener('click', () => import('./ui-window.js').then(m => m.showWindow()));
    document.getElementById('scp-download-debug')?.addEventListener('click', () => import('../utils/util-debug.js').then(m => m.dbgDownload()));
    document.getElementById('scp-open-memory-settings')?.addEventListener('click', () => { openSettingsPanel(); setTimeout(() => document.querySelector('[data-sptab="memory"]')?.click(), 80); });
    document.getElementById('scp-open-tools-settings')?.addEventListener('click', () => { openSettingsPanel(); setTimeout(() => document.querySelector('[data-sptab="tools"]')?.click(), 80); });
    document.getElementById('scp-clear-sessions')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Очистить все сессии', message: 'Удалить ВСЕ сессии Copilot? Это действие нельзя отменить.', delayConfirm: 3 }); if (!ok) return;
        const { charId, chatId } = getBindingKey();
        _dbgAdd('SESSION_CLEAR_REQUESTED', { source: 'st-drawer', charId, chatId });
        getSettings().sessions = {}; saveSettings();
        const oldFileId = SillyTavern.getContext().chatMetadata?.st_copilot?.file_id || null;
        try {
            await initChatBucket({ forceReset: true });
            if (oldFileId) await deleteSessionFile(oldFileId);
            _dbgAdd('SESSION_CLEAR_DONE', { source: 'st-drawer', charId, chatId });
        } catch (e) {
            _dbgAdd('SESSION_CLEAR_FAILED', { source: 'st-drawer', charId, chatId, error: e?.message || String(e), stack: e?.stack });
            toastr.error(`Не удалось очистить сессии: ${e.message}`, EXT_DISPLAY);
            return;
        }
        import('./ui-chat.js').then(m => m.onChatChanged());
        toastr.success('Сессии очищены.', EXT_DISPLAY);
    });

    refreshProfilesDropdown();
}

export function setupSettingsPanelListeners() {
    const overlay = document.getElementById('scp-settings-overlay'); if (!overlay) return;

    document.getElementById('scp-sp-close')?.addEventListener('click', () => closeSettingsPanel());
    let _spMD = null;
    overlay.addEventListener('mousedown', e => { _spMD = e.target; });
    overlay.addEventListener('click', e => { if (e.target === overlay && _spMD === overlay) closeSettingsPanel(); });

    // ── Tab switching ──
    overlay.querySelectorAll('.scp-sp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            overlay.querySelectorAll('.scp-sp-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
            const pane = tab.dataset.sptab;
            overlay.querySelectorAll('.scp-sp-tab-pane').forEach(p => { p.style.display = p.id === `scp-sp-pane-${pane}` ? '' : 'none'; });
            if (pane === 'stats') import('../features/feature-stats.js').then(m => { const c = document.getElementById('scp-sp-stats-container'); if (c) m.renderStatsPane(c); });
            if (pane === 'memory') import('../features/feature-memory.js').then(m => m.setupMemorySettingsUI());
            if (pane === 'tools') import('../features/feature-tools-ui.js').then(m => m.setupToolsSettingsUI());
        });
    });

    // ── SP forceStreaming ──
    document.querySelectorAll('.scp-stream-btn:not(.scp-ov-stream-btn)').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.stream; getSettings().forceStreaming = val; saveSettings();
            syncOverlayUI('forceStreaming', val); _markDirty('config');
        });
    });

    // ── SP Profile management ──
    document.getElementById('scp-sp-profile-select')?.addEventListener('change', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        if (isConfigProfileDirty()) {
            const ok = await showCustomDialog({ type: 'confirm', title: 'Несохранённая конфигурация', message: 'Несохранённые изменения. Переключиться всё равно?' });
            if (!ok) { sel.value = getSettings().activeProfile || ''; return; }
        }
        loadProfile(sel.value); syncSPFromSettings(); updateSettingsUI(); updateSPBindingSection();
    });
    document.getElementById('scp-sp-profile-save')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); let name = sel?.value;
        if (!name) { name = await showCustomDialog({ type: 'prompt', title: 'Сохранить конфигурацию', message: 'Название профиля:', placeholder: 'Моя конфигурация' }); if (!name?.trim()) return; name = name.trim(); }
        saveProfile(name); refreshSPProfilesDropdown(); refreshProfilesDropdown(); if (sel) sel.value = name;
        updateSPBindingSection(); toastr.success(`Сохранено "${name}"`, EXT_DISPLAY); _clearDirty('config');
    });
    document.getElementById('scp-sp-profile-create')?.addEventListener('click', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'Новая конфигурация', message: 'Название:', placeholder: 'Новая конфигурация' }); if (!name?.trim()) return;
        const n = name.trim(); const s = getSettings();
        s.profiles[n] = { systemPrompt: DEFAULT_SYSTEM_PROMPT, includeSystemPrompt: true, includeAuthorsNote: true, includeCharacterCard: true, includeUserPersonality: true, contextDepth: 15, localHistoryLimit: 50, connectionSource: 'default', connectionProfileId: '', maxTokens: 8200, applyRegexToContext: true };
        saveSettings(); refreshSPProfilesDropdown(); refreshProfilesDropdown(); loadProfile(n); syncSPFromSettings(); updateSettingsUI();
        const sel = document.getElementById('scp-sp-profile-select'); if (sel) sel.value = n;
        updateSPBindingSection(); toastr.success(`Создано "${n}"`, EXT_DISPLAY);
    });
    document.getElementById('scp-sp-profile-duplicate')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return toastr.info('Конфигурация не выбрана.', EXT_DISPLAY);
        const newName = await showCustomDialog({ type: 'prompt', title: 'Дублировать конфигурацию', message: 'Название для нового профиля:', defaultValue: sel.value + ' (Копия)' }); if (!newName?.trim()) return;
        const n = newName.trim(); const s = getSettings(); const p = s.profiles[sel.value]; if (!p) return;
        s.profiles[n] = JSON.parse(JSON.stringify(p)); saveSettings(); refreshSPProfilesDropdown(); refreshProfilesDropdown(); loadProfile(n); syncSPFromSettings(); updateSettingsUI();
        const newSel = document.getElementById('scp-sp-profile-select'); if (newSel) newSel.value = n;
        updateSPBindingSection(); toastr.success(`Дублировано как "${n}"`, EXT_DISPLAY);
    });
    document.getElementById('scp-sp-profile-rename')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const newName = await showCustomDialog({ type: 'prompt', title: 'Переименовать', message: 'Новое название:', defaultValue: sel.value }); if (!newName?.trim() || newName.trim() === sel.value) return;
        const s = getSettings(); const p = s.profiles[sel.value]; if (!p) return;
        s.profiles[newName.trim()] = p; delete s.profiles[sel.value];
        if (s.activeProfile === sel.value) s.activeProfile = newName.trim();
        for (const k in s.profileBindings) { if (s.profileBindings[k] === sel.value) s.profileBindings[k] = newName.trim(); }
        saveSettings(); refreshSPProfilesDropdown(); refreshProfilesDropdown();
        const newSel = document.getElementById('scp-sp-profile-select'); if (newSel) newSel.value = newName.trim();
        updateSPBindingSection(); toastr.success('Переименовано.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-profile-delete')?.addEventListener('click', async () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); if (Object.keys(s.profiles).length <= 1) { toastr.warning('Невозможно удалить последний профиль.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить профиль', message: `Удалить "${sel.value}"?` }); if (!ok) return;
        deleteProfile(sel.value); refreshSPProfilesDropdown(); refreshProfilesDropdown(); updateSPBindingSection(); toastr.success('Удалено.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-bind-char')?.addEventListener('click', () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); const { charId } = getBindingKey(); const key = `char_${charId}`;
        if (s.profileBindings[key] === sel.value) delete s.profileBindings[key]; else s.profileBindings[key] = sel.value;
        saveSettings(); updateSPBindingSection(); document.getElementById('scp-sp-bind-char')?.classList.toggle('active', s.profileBindings[key] === sel.value);
    });
    document.getElementById('scp-sp-bind-chat')?.addEventListener('click', () => {
        const sel = document.getElementById('scp-sp-profile-select'); if (!sel?.value) return;
        const s = getSettings(); const { charId, chatId } = getBindingKey(); const key = `chat_${charId}_${chatId}`;
        if (s.profileBindings[key] === sel.value) delete s.profileBindings[key]; else s.profileBindings[key] = sel.value;
        saveSettings(); updateSPBindingSection(); document.getElementById('scp-sp-bind-chat')?.classList.toggle('active', s.profileBindings[key] === sel.value);
    });

    // ── SP conn profile ──
    document.getElementById('scp-sp-conn-profile')?.addEventListener('change', e => {
        getSettings().connectionProfileId = e.target.value; saveSettings(); syncOverlayUI('connectionProfileId', e.target.value); _markDirty('config');
    });

    // ── SP Reset buttons ──
    document.getElementById('scp-sp-reset-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить системный промпт', message: 'Сбросить к значению по умолчанию?' }); if (!ok) return;
        getSettings().systemPrompt = DEFAULT_SYSTEM_PROMPT; saveSettings();
        ['scp-sp-sysprompt', 'scp-sysprompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_SYSTEM_PROMPT; });
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession())); toastr.success('Системный промпт сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-reset-lb-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт лорбука', message: 'Сбросить к значению по умолчанию?' }); if (!ok) return;
        getSettings().lorebookManagePrompt = DEFAULT_LB_MANAGE_PROMPT; saveSettings();
        ['scp-sp-lb-manage-prompt', 'scp-lb-manage-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_LB_MANAGE_PROMPT; });
        toastr.success('Промпт лорбука сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-reset-char-edit-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт редактирования персонажа', message: 'Сбросить к встроенному значению по умолчанию?' }); if (!ok) return;
        getSettings().charEditPrompt = ''; saveSettings(); _markDirty('config');
        ['scp-sp-char-edit-prompt', 'scp-char-edit-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_CHAR_EDIT_DIRECTIVE.trim(); });
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession())); toastr.success('Промпт редактирования персонажа сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-reset-chat-edit-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт редактирования чата', message: 'Сбросить к значению по умолчанию?' }); if (!ok) return;
        getSettings().chatEditPrompt = ''; saveSettings(); _markDirty('config');
        ['scp-sp-chat-edit-prompt', 'scp-chat-edit-prompt-st'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_CHAT_EDIT_DIRECTIVE.trim(); });
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession())); toastr.success('Промпт редактирования чата сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-reset-memory-prompt')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт', message: 'Сбросить промпт памяти к значению по умолчанию?' }); if (!ok) return;
        getSettings().memoryManagePrompt = DEFAULT_MEMORY_PROMPT; saveSettings();
        ['scp-sp-memory-prompt', 'scp-memory-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEFAULT_MEMORY_PROMPT; });
        toastr.success('Промпт сброшен.', EXT_DISPLAY);
    });
    document.getElementById('scp-sp-tools-reset')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить промпт', message: 'Сбросить промпт инструментов к значению по умолчанию?' }); if (!ok) return;
        getSettings().toolsSystemPrompt = DEFAULT_TOOLS_PROMPT; saveSettings();
        const ta = document.getElementById('scp-sp-tools-prompt'); if (ta) ta.value = DEFAULT_TOOLS_PROMPT;
        toastr.success('Промпт инструментов сброшен.', EXT_DISPLAY);
    });

    // ── Misc SP ──
    document.getElementById('scp-sp-open-changelog')?.addEventListener('click', () => { closeSettingsPanel(); import('./ui-widgets.js').then(m => m.openChangelog()); });
    document.getElementById('scp-sp-download-debug')?.addEventListener('click', () => import('../utils/util-debug.js').then(m => m.dbgDownload()));
    document.getElementById('scp-sp-clear-sessions')?.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Очистить все сессии', message: 'Удалить ВСЕ сессии Copilot? Это действие нельзя отменить.', delayConfirm: 3 }); if (!ok) return;
        const { charId, chatId } = getBindingKey();
        _dbgAdd('SESSION_CLEAR_REQUESTED', { source: 'settings-overlay', charId, chatId });
        getSettings().sessions = {}; saveSettings();
        const oldFileId = SillyTavern.getContext().chatMetadata?.st_copilot?.file_id || null;
        try {
            await initChatBucket({ forceReset: true });
            if (oldFileId) await deleteSessionFile(oldFileId);
            _dbgAdd('SESSION_CLEAR_DONE', { source: 'settings-overlay', charId, chatId });
            import('./ui-chat.js').then(m => m.onChatChanged());
            toastr.success('Сессии очищены.', EXT_DISPLAY);
        } catch (e) {
            _dbgAdd('SESSION_CLEAR_FAILED', { source: 'settings-overlay', charId, chatId, error: e?.message || String(e), stack: e?.stack });
            toastr.error(`Не удалось очистить сессии: ${e.message}`, EXT_DISPLAY);
        }
    });
    document.getElementById('scp-sp-reset-all-overrides')?.addEventListener('click', async () => {
        if (!hasSessionOverrides()) { toastr.info('Нет активных переопределений сессии.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить переопределения сессии', message: 'Очистить все переопределения сессии для этой сессии?' }); if (!ok) return;
        clearAllSessionOverrides(); syncSPFromSettings();
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession())); toastr.success('Переопределения сессии очищены.', EXT_DISPLAY);
    });

    // ── Session Override bindings ──
    const bindOv = (id, key, isCheckbox = false, toVal = null) => {
        const el = document.getElementById(id); if (!el) return;
        let _ovDebounce = 0;
        el.addEventListener(isCheckbox ? 'change' : 'input', () => {
            const raw = isCheckbox ? el.checked : el.value;
            const val = (raw === '' || raw === undefined) ? undefined : (toVal ? toVal(raw) : raw);
            if (isCheckbox) { _syncOvToGlobal(key, val); return; }
            clearTimeout(_ovDebounce);
            _ovDebounce = setTimeout(() => _syncOvToGlobal(key, val), 300);
        });
    };
    const bindOvSel = (id, key) => { const el = document.getElementById(id); if (!el) return; el.addEventListener('change', () => _syncOvToGlobal(key, el.value || undefined)); };

    const ovDs = document.getElementById('scp-sp-ov-depth-slider'); const ovDv = document.getElementById('scp-sp-ov-depth-val');
    if (ovDs) { ovDs.addEventListener('input', () => { if (ovDv) ovDv.textContent = ovDs.value; }); ovDs.addEventListener('change', () => _syncOvToGlobal('contextDepth', parseInt(ovDs.value))); }

    document.getElementById('scp-sp-ov-conn-source')?.addEventListener('change', e => {
        _syncOvToGlobal('connectionSource', e.target.value);
        const pg = document.getElementById('scp-sp-ov-profile-group'); const cg = document.getElementById('scp-sp-ov-custom-profile-group');
        if (pg) pg.style.display = e.target.value === 'profile' ? '' : 'none';
        if (cg) cg.style.display = e.target.value === 'custom' ? '' : 'none';
        if (e.target.value === 'profile') updateSPConnProfileList();
    });
    bindOv('scp-sp-ov-custom-url', 'customUrl'); bindOv('scp-sp-ov-custom-key', 'customKey'); bindOv('scp-sp-ov-custom-model', 'customModel');
    bindOvSel('scp-sp-ov-conn-profile', 'connectionProfileId');
    bindOv('scp-sp-ov-max-tokens', 'maxTokens', false, Number); bindOv('scp-sp-ov-history-limit', 'localHistoryLimit', false, Number);
    bindOv('scp-sp-ov-reasoning-trim', 'reasoningTrimStrings'); bindOv('scp-sp-ov-char-edit-prompt', 'charEditPrompt');
    bindOv('scp-sp-ov-lb-manage-prompt', 'lorebookManagePrompt'); bindOv('scp-sp-ov-chat-edit-prompt', 'chatEditPrompt');
    {
        let _sysOvDebounce = 0;
        document.getElementById('scp-sp-ov-sysprompt')?.addEventListener('input', e => {
            const v = e.target.value || undefined;
            clearTimeout(_sysOvDebounce);
            _sysOvDebounce = setTimeout(() => _syncOvToGlobal('systemPrompt', v), 300);
        });
    }
    bindOv('scp-sp-ov-include-sysprompt',  'includeSystemPrompt',     true);
    bindOv('scp-sp-ov-include-persona',    'includeUserPersonality',   true);
    bindOv('scp-sp-ov-include-alt-swipes', 'includeAlternateSwipes',   true);
    bindOv('scp-sp-ov-apply-regex',        'applyRegexToContext',      true);
    bindOv('scp-sp-ov-char-edit-enabled',  'charEditAIEnabled',        true);
    bindOv('scp-sp-ov-lb-ai-enabled',      'lorebookAIManageEnabled',  true);
    bindOv('scp-sp-ov-chat-edit-enabled',  'chatEditAIEnabled',        true);
    bindOv('scp-sp-ov-lb-auto-kw',         'lorebookAutoKeyword',      true);

    // Override streaming buttons
    document.querySelectorAll('.scp-ov-stream-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.stream; _syncOvToGlobal('forceStreaming', val);
            document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
                const active = b.dataset.stream === val; b.classList.toggle('active', active);
                b.style.color = active ? 'var(--scp-accent)' : ''; b.style.borderColor = active ? 'var(--scp-accent-dim)' : ''; b.style.background = active ? 'var(--scp-accent-bg)' : '';
            });
        });
    });

    // CE override fields
    _CE_FIELDS_DEF.forEach(ceDef => {
        bindOv(ceDef.ovId, 'charField_' + ceDef.fk, true);
        if (ceDef.altGreetingPicker) {
            document.getElementById(ceDef.ovId)?.addEventListener('change', e => {
                const picker = document.getElementById('scp-sp-ov-ce-alt-greetings-picker');
                if (picker) picker.style.display = e.target.checked ? '' : 'none';
                import('../features/feature-character-ui.js').then(m => m.refreshAltGreetingsPickers());
            });
        }
    });

    // Override clear buttons
    document.querySelectorAll('.scp-sp-ov-clear[data-ovkey]').forEach(btn => {
        btn.addEventListener('click', () => {
            setSessionOverride(btn.dataset.ovkey, undefined);
            _resetOvElToEffective(btn.dataset.ovkey);
            updateSPOverrideIndicators();
            import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
        });
    });

}

// ─── Quick Prompts Settings UI ────────────────────────────────────────────────

export function buildQPSettingsUI(container) {
    if (!container) return;
    container.innerHTML = '';
    const list = document.createElement('div'); list.className = 'scp-qp-settings-list';

    const renderList = () => {
        list.innerHTML = '';
        const prompts = getSettings().quickPrompts || [];
        if (!prompts.length) { list.innerHTML = `<div style="font-size:11px;color:var(--scp-text-muted);text-align:center;padding:10px 0">Быстрых промптов пока нет. Добавьте один ниже.</div>`; }
        prompts.forEach((qp, idx) => {
            const row = document.createElement('div'); row.className = 'scp-qp-settings-row';
            const iconBtn = document.createElement('button'); iconBtn.className = 'scp-qp-settings-icon-btn'; iconBtn.textContent = qp.icon || '⚡'; iconBtn.title = 'Сменить значок';
            import('./ui-widgets.js').then(mod => {
                iconBtn.addEventListener('click', e => { e.stopPropagation(); mod.showQPIconPicker(iconBtn, qp.icon || '⚡', emoji => { getSettings().quickPrompts[idx].icon = emoji; saveSettings(); iconBtn.textContent = emoji; mod.renderQuickPromptsBar(); }); });
            });
            const labelInput = document.createElement('input'); labelInput.type = 'text'; labelInput.className = 'scp-qp-settings-label-input scp-sp-input'; labelInput.placeholder = 'Метка'; labelInput.value = qp.label || '';
            labelInput.addEventListener('input', () => { getSettings().quickPrompts[idx].label = labelInput.value; saveSettings(); import('./ui-widgets.js').then(m => m.renderQuickPromptsBar()); });
            const moveUpBtn = document.createElement('button'); moveUpBtn.className = 'scp-qp-settings-move'; moveUpBtn.textContent = '↑'; moveUpBtn.title = 'Переместить вверх'; moveUpBtn.disabled = idx === 0;
            moveUpBtn.addEventListener('click', () => { if (idx === 0) return; const arr = getSettings().quickPrompts; [arr[idx-1], arr[idx]] = [arr[idx], arr[idx-1]]; saveSettings(); renderList(); import('./ui-widgets.js').then(m => m.renderQuickPromptsBar()); });
            const moveDnBtn = document.createElement('button'); moveDnBtn.className = 'scp-qp-settings-move'; moveDnBtn.textContent = '↓'; moveDnBtn.title = 'Переместить вниз'; moveDnBtn.disabled = idx === prompts.length - 1;
            moveDnBtn.addEventListener('click', () => { const arr = getSettings().quickPrompts; if (idx >= arr.length - 1) return; [arr[idx], arr[idx+1]] = [arr[idx+1], arr[idx]]; saveSettings(); renderList(); import('./ui-widgets.js').then(m => m.renderQuickPromptsBar()); });
            const delBtn = document.createElement('button'); delBtn.className = 'scp-qp-settings-del'; delBtn.innerHTML = I.trash; delBtn.title = 'Удалить';
            delBtn.addEventListener('click', async () => { const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить промпт', message: `Удалить "${qp.label || 'этот промпт'}"?` }); if (!ok) return; getSettings().quickPrompts.splice(idx, 1); saveSettings(); renderList(); import('./ui-widgets.js').then(m => m.renderQuickPromptsBar()); });
            const textArea = document.createElement('textarea'); textArea.className = 'scp-qp-settings-text scp-sp-textarea'; textArea.placeholder = 'Текст промпта… (поддерживает макросы {{user}}, {{char}})'; textArea.rows = 2; textArea.value = qp.text || '';
            textArea.addEventListener('input', () => { getSettings().quickPrompts[idx].text = textArea.value; saveSettings(); });
            const controls = document.createElement('div'); controls.className = 'scp-qp-settings-controls'; controls.appendChild(moveUpBtn); controls.appendChild(moveDnBtn); controls.appendChild(delBtn);
            const top = document.createElement('div'); top.className = 'scp-qp-settings-row-top'; top.appendChild(iconBtn); top.appendChild(labelInput); top.appendChild(controls);
            row.appendChild(top); row.appendChild(textArea); list.appendChild(row);
        });
    };
    renderList();

    const addBtn = document.createElement('button'); addBtn.className = 'scp-action-btn'; addBtn.style.marginTop = '8px'; addBtn.innerHTML = `${I.plus}<span>Добавить промпт</span>`;
    addBtn.addEventListener('click', async () => {
        const label = await showCustomDialog({ type: 'prompt', title: 'Новый быстрый промпт', message: 'Метка для этого промпта:', placeholder: 'Мой промпт' }); if (label === null) return;
        getSettings().quickPrompts.push({ id: 'qp_'+Date.now(), label: label.trim() || 'Промпт', icon: '⚡', text: '' }); saveSettings(); renderList(); import('./ui-widgets.js').then(m => m.renderQuickPromptsBar());
    });
    container.appendChild(list); container.appendChild(addBtn);
}