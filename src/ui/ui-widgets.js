// Facade over the ui-widgets submodule split (preset builders,
// sound/changelog/favorites panels, context inspector). Historical import
// sites (index.js, api.js, chat-shared lazy refs, ui-settings, prompt-builder,
// request-inspector) keep importing everything from here.
export {
    renderQuickPromptsBar,
    showQPIconPicker,
    openPresetDropdown,
    closePresetPanel,
    buildPromptPresetManager,
    buildQPSetManager,
} from './widget-presets.js';

export {
    _SOUND_PRESETS,
    _synthSound,
    playCompletionSound,
    buildChangelogHTML,
    openChangelog,
    closeChangelog,
    checkChangelogAutoShow,
    setupChangelogListeners,
    renderFavoritesPanel,
    openFavoritesPanel,
    closeFavoritesPanel,
    buildSoundSettingsUI,
} from './widget-panels.js';

export {
    setupContextSearch,
    _highlightContextText,
    _buildContextInspectorHTML,
    _lastInspectorMessages,
    openInspector,
} from './widget-inspector.js';
