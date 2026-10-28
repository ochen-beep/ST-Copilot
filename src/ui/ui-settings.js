// Facade over the ui-settings submodule split (defs, profiles/themes, engine,
// panel). Historical import sites (index.js, session.js, session-view.js,
// feature-tools-ui, chat-shared lazy refs) keep importing everything from here.
export {
    _takeProfileSnapshot,
    isConfigProfileDirty,
    _markDirty,
    _clearDirty,
    _updateDirtyDots,
    saveProfile,
    loadProfile,
    deleteProfile,
    refreshProfilesDropdown,
    updateBindingSection,
    autoLoadBoundProfile,
    updateProfilesList,
    updateSPConnProfileList,
    refreshSPProfilesDropdown,
    updateSPBindingSection,
    isThemeDirty,
    buildThemeEditor,
} from './settings-profiles.js';

export {
    syncOverlayUI,
    updateSettingsUI,
    syncSPFromSettings,
    updateSPOverrideIndicators,
    updateSessionOverrideIndicator,
} from './settings-core.js';

export {
    openSettingsPanel,
    closeSettingsPanel,
    setupSettingsHandlers,
    setupSettingsPanelListeners,
    buildQPSettingsUI,
} from './settings-panel.js';
