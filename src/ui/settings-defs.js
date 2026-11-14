// Settings definitions: the field registry binding settings keys to ST-drawer
// and settings-overlay elements, charEdit field defs, the override-element map
// and the derived profile key list. Split out of ui-settings.js (now a
// re-export facade); engine/sync/profiles/panel live in sibling submodules.
import { THEME_PRESETS, DEFAULT_SYSTEM_PROMPT, DEFAULT_CHAR_EDIT_DIRECTIVE, DEFAULT_LB_MANAGE_PROMPT, DEFAULT_CHAT_EDIT_DIRECTIVE, DEFAULT_MEMORY_PROMPT } from '../constants.js';
import { state } from '../state.js';
import { getSettings } from '../session.js';
import { _applyConnectionSourceVisibility } from './settings-core.js';
// ─── Settings Registry ────────────────────────────────────────────────────────
//
// FIELDS:
//   key             — key in the settings object
//   stId            — element id in the ST-drawer (null if none)
//   spId            — element id in the overlay (null if none)
//   type            — 'checkbox' | 'input' | 'textarea' | 'select' | 'slider'
//   toVal           — transforms el.value before saving (optional)
//   fromSetting     — s => val, how to read from settings for display (optional)
//   stValId/spValId — ID of the display span for sliders
//   valFmt          — v => string, formatting for slider values
//   onChange        — (val) => void, side effect after saving
//   updCtx          — update token counter
//   profileKey      — include in configuration profiles

export const _SETTINGS_DEF = [
    // ── General ──────────────────────────────────────────────────────────────
    { key: 'enabled', stId: 'scp-enabled', spId: 'scp-sp-enabled', type: 'checkbox',
      onChange: val => {
          const btn = document.getElementById('scp-wand-btn');
          if (btn) btn.style.display = val ? '' : 'none';
          if (!val) import('./ui-window.js').then(m => m.hideWindow());
          import('./ui-window.js').then(m => m.setupHotkey());
          // v2.10.0: launcher mounts/unmounts based on enabled.
          import('./ui-launcher.js').then(m => m.ensureLauncher({ onToggle: () => import('./ui-window.js').then(w => w.toggleVisibility()) }));
      }
    },
    { key: 'hotkeyEnabled',        stId: 'scp-hotkey-enabled',        spId: 'scp-sp-hotkey-enabled',        type: 'checkbox' },
    { key: 'hotkey',               stId: 'scp-hotkey',                spId: 'scp-sp-hotkey',                type: 'input',
      onChange: () => import('./ui-window.js').then(m => m.setupHotkey()) },
    { key: 'searchHotkeyEnabled',  stId: 'scp-search-hotkey-enabled', spId: 'scp-sp-search-hotkey-enabled', type: 'checkbox',
      onChange: () => import('./ui-chat.js').then(m => m.setupSearchHotkey()) },
    { key: 'searchHotkey',         stId: 'scp-search-hotkey',         spId: 'scp-sp-search-hotkey',         type: 'input',
      onChange: () => import('./ui-chat.js').then(m => m.setupSearchHotkey()) },
    // v2.10.0: launcherMode picks the window-invocation control: 'bar' (quick-reply
    // bar button), 'floating' (draggable dock icon), 'both'. Replaces the removed FAB
    // setting floatingIconPersistent (migrated in session.js).
    { key: 'launcherMode', stId: 'scp-launcher-mode', spId: 'scp-sp-launcher-mode', type: 'select',
      onChange: () => import('./ui-launcher.js').then(m => {
          m.ensureLauncher({ onToggle: () => import('./ui-window.js').then(w => w.toggleVisibility()) });
          m.refreshLauncher();
      }) },
    { key: 'wobbleWindow',   stId: 'scp-wobble-window',  spId: 'scp-sp-wobble-window', type: 'checkbox', fromSetting: s => s.wobbleWindow !== false },
    { key: 'performanceMode', stId: 'scp-perf-mode', spId: 'scp-sp-perf-mode', type: 'checkbox',
      onChange: () => import('./ui-window.js').then(m => m.applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default)) },
    { key: 'changelogAutoShow',    stId: null, spId: 'scp-sp-changelog-auto', type: 'checkbox' },
    { key: 'includeSummaryception', stId: 'scp-include-summaryception', spId: 'scp-sp-include-summaryception', type: 'checkbox', fromSetting: s => s.includeSummaryception !== false },
    { key: 'useAspectEvolutia',    stId: 'scp-use-aspect-evolutia',    spId: 'scp-sp-use-aspect-evolutia',    type: 'checkbox', fromSetting: s => s.useAspectEvolutia !== false },
    { key: 'autoExpandMacros',     stId: 'scp-auto-expand-macros',     spId: 'scp-sp-auto-expand-macros',     type: 'checkbox' },
    { key: 'includeHiddenMessages', stId: 'scp-include-hidden-msgs',   spId: 'scp-sp-include-hidden-msgs',    type: 'checkbox', updCtx: true },
    { key: 'completionSoundOnlyWhenUnfocused', stId: 'scp-sound-unfocused', spId: 'scp-sp-sound-unfocused',  type: 'checkbox' },

    // ── Sliders ───────────────────────────────────────────────────────────────
    { key: 'opacity', stId: 'scp-opacity-slider', spId: 'scp-sp-opacity-slider', type: 'slider', toVal: Number,
      stValId: 'scp-opacity-val', spValId: 'scp-sp-opacity-val', valFmt: v => `${v}%`,
      onChange: val => { const w = document.getElementById('scp-window'); if (w) w.style.opacity = (val / 100).toString(); } },

    // ── Connection ────────────────────────────────────────────────────────────
    { key: 'connectionSource',  stId: 'scp-conn-source',  spId: 'scp-sp-conn-source',  type: 'select', profileKey: true, onChange: _applyConnectionSourceVisibility },
    { key: 'connectionProfileId', stId: 'scp-conn-profile', spId: 'scp-sp-conn-profile', type: 'select', profileKey: true },
    { key: 'customUrl',   stId: 'scp-custom-url',   spId: 'scp-sp-custom-url',   type: 'input', profileKey: true },
    { key: 'customKey',   stId: 'scp-custom-key',   spId: 'scp-sp-custom-key',   type: 'input', profileKey: true },
    { key: 'customModel', stId: 'scp-custom-model', spId: 'scp-sp-custom-model', type: 'input', profileKey: true },
    { key: 'maxTokens',   stId: 'scp-max-tokens',   spId: 'scp-sp-max-tokens',   type: 'input', toVal: Number, profileKey: true },

    // ── Context ───────────────────────────────────────────────────────────────
    { key: 'contextDepth', stId: 'scp-depth-slider', spId: 'scp-sp-depth-slider', type: 'slider', toVal: Number,
      stValId: 'scp-depth-val', spValId: 'scp-sp-depth-val', updCtx: true, profileKey: true },
    { key: 'localHistoryLimit',   stId: 'scp-history-limit',    spId: 'scp-sp-history-limit',    type: 'input',    toVal: Number, updCtx: true, profileKey: true },
    { key: 'includeSystemPrompt', stId: 'scp-include-sysprompt', spId: 'scp-sp-include-sysprompt', type: 'checkbox', updCtx: true, profileKey: true },
    { key: 'includeUserPersonality', stId: 'scp-include-persona', spId: 'scp-sp-include-persona', type: 'checkbox', updCtx: true, profileKey: true },
    { key: 'includeAlternateSwipes', stId: 'scp-include-alt-swipes', spId: 'scp-sp-include-alt-swipes', type: 'checkbox', updCtx: true, profileKey: true },
    { key: 'applyRegexToContext', stId: 'scp-apply-regex', spId: 'scp-sp-apply-regex', type: 'checkbox', updCtx: true, profileKey: true },
    { key: 'reasoningTrimStrings', stId: 'scp-reasoning-trim', spId: 'scp-sp-reasoning-trim', type: 'textarea', profileKey: true },

    // ── Prompts ───────────────────────────────────────────────────────────────
    { key: 'systemPrompt', stId: 'scp-sysprompt', spId: 'scp-sp-sysprompt', type: 'textarea', updCtx: true, profileKey: true,
      fromSetting: s => s.systemPrompt || DEFAULT_SYSTEM_PROMPT },

    // ── Character Edit ────────────────────────────────────────────────────────
    { key: 'charEditAIEnabled', stId: 'scp-char-edit-enabled', spId: 'scp-sp-char-edit-enabled', type: 'checkbox', updCtx: true, profileKey: true },
    { key: 'charEditPrompt', stId: 'scp-char-edit-prompt', spId: 'scp-sp-char-edit-prompt', type: 'textarea', updCtx: true, profileKey: true,
      fromSetting: s => s.charEditPrompt || DEFAULT_CHAR_EDIT_DIRECTIVE.trim(),
      toVal: v => v.trim() === DEFAULT_CHAR_EDIT_DIRECTIVE.trim() ? '' : v },

    // ── Lorebook ──────────────────────────────────────────────────────────────
    { key: 'lorebookAIManageEnabled', stId: 'scp-lb-ai-enabled-st', spId: 'scp-sp-lb-ai-enabled', type: 'checkbox', profileKey: true },
    { key: 'lorebookAutoKeyword', stId: 'scp-lb-auto-kw-st', spId: 'scp-sp-lb-auto-kw', type: 'checkbox', profileKey: true,
      onChange: () => {
          const s = getSettings();
          import('../features/feature-lorebook-engine.js').then(async m => {
              await m.buildLorebookContextBlock(s);
              import('../features/feature-lorebook-ui.js').then(ui => {
                  ui.updateLBFooterInfo();
                  if (state.lbActiveBook) ui.renderEntryList(state.lbActiveBook, state.lbSearchQuery);
              });
          });
      }
    },
    { key: 'lorebookManagePrompt', stId: 'scp-lb-manage-prompt', spId: 'scp-sp-lb-manage-prompt', type: 'textarea', profileKey: true,
      fromSetting: s => s.lorebookManagePrompt || DEFAULT_LB_MANAGE_PROMPT },
    { key: 'lorebookSTScanDepth',     stId: 'scp-lb-st-scan-depth',      spId: 'scp-sp-lb-st-scan-depth',      type: 'input', toVal: Number, profileKey: true },
    { key: 'lorebookCopilotScanDepth', stId: 'scp-lb-copilot-scan-depth', spId: 'scp-sp-lb-copilot-scan-depth', type: 'input', toVal: Number, profileKey: true },

    // ── Chat Edit ─────────────────────────────────────────────────────────────
    { key: 'chatEditAIEnabled', stId: 'scp-chat-edit-enabled-st', spId: 'scp-sp-chat-edit-enabled', type: 'checkbox', updCtx: true, profileKey: true },
    { key: 'chatEditPrompt', stId: 'scp-chat-edit-prompt-st', spId: 'scp-sp-chat-edit-prompt', type: 'textarea', updCtx: true, profileKey: true,
      fromSetting: s => s.chatEditPrompt || DEFAULT_CHAT_EDIT_DIRECTIVE.trim(),
      toVal: v => v.trim() === DEFAULT_CHAT_EDIT_DIRECTIVE.trim() ? '' : v },

    // ── Memory ────────────────────────────────────────────────────────────────
    { key: 'memoryEnabled',      stId: 'scp-memory-enabled', spId: 'scp-sp-memory-enabled', type: 'checkbox', updCtx: true },
    { key: 'memoryInject',       stId: 'scp-memory-inject',  spId: 'scp-sp-memory-inject',  type: 'checkbox', updCtx: true },
    { key: 'memoryNotify',       stId: null,                 spId: 'scp-sp-memory-notify',  type: 'checkbox' },
    { key: 'memoryManagePrompt', stId: 'scp-memory-prompt',  spId: 'scp-sp-memory-prompt',  type: 'textarea', updCtx: true,
      fromSetting: s => s.memoryManagePrompt || DEFAULT_MEMORY_PROMPT },

    // ── Tools ─────────────────────────────────────────────────────────────────
    { key: 'toolsEnabled', stId: 'scp-tools-enabled', spId: 'scp-sp-tools-enabled', type: 'checkbox', updCtx: true },

    // ── Misc ──────────────────────────────────────────────────────────────────
    { key: 'pickerPreviewLines',     stId: 'scp-picker-lines',      spId: 'scp-sp-picker-lines',      type: 'input', toVal: v => parseInt(v) || 1 },
    { key: 'pickerPreviewLastLines', stId: 'scp-picker-last-lines', spId: 'scp-sp-picker-last-lines', type: 'input', toVal: v => parseInt(v) || 0 },
    { key: 'imageAnalysisMode',      stId: 'scp-image-mode',        spId: 'scp-sp-image-mode',        type: 'select' },
];

// charEditFields
export const _CE_FIELDS_DEF = [
    { fk: 'tags',                      stId: 'scp-ce-tags',           spId: 'scp-sp-ce-tags',           ovId: 'scp-sp-ov-ce-tags' },
    { fk: 'description',               stId: 'scp-ce-description',    spId: 'scp-sp-ce-description',    ovId: 'scp-sp-ov-ce-description' },
    { fk: 'personality',               stId: 'scp-ce-personality',    spId: 'scp-sp-ce-personality',    ovId: 'scp-sp-ov-ce-personality' },
    { fk: 'scenario',                  stId: 'scp-ce-scenario',       spId: 'scp-sp-ce-scenario',       ovId: 'scp-sp-ov-ce-scenario' },
    { fk: 'first_mes',                 stId: 'scp-ce-first-mes',      spId: 'scp-sp-ce-first-mes',      ovId: 'scp-sp-ov-ce-first-mes' },
    { fk: 'mes_example',               stId: 'scp-ce-mes-example',    spId: 'scp-sp-ce-mes-example',    ovId: 'scp-sp-ov-ce-mes-example' },
    { fk: 'authors_note',              stId: 'scp-ce-authors-note',   spId: 'scp-sp-ce-authors-note',   ovId: 'scp-sp-ov-ce-authors-note' },
    { fk: 'system_prompt',             stId: 'scp-ce-system-prompt',  spId: 'scp-sp-ce-system-prompt',  ovId: 'scp-sp-ov-ce-system-prompt' },
    { fk: 'post_history_instructions', stId: 'scp-ce-post-history',   spId: 'scp-sp-ce-post-history',   ovId: 'scp-sp-ov-ce-post-history' },
    { fk: 'alternate_greetings',       stId: 'scp-ce-alt-greetings',  spId: 'scp-sp-ce-alt-greetings',  ovId: 'scp-sp-ov-ce-alt-greetings', altGreetingPicker: true },
];

// Mapping override keys to elements (for the override reset button)
export const _OV_EL_MAP = {
    contextDepth: ['scp-sp-ov-depth-slider', 'scp-sp-ov-depth-val'],
    maxTokens: ['scp-sp-ov-max-tokens'],           localHistoryLimit: ['scp-sp-ov-history-limit'],
    reasoningTrimStrings: ['scp-sp-ov-reasoning-trim'], systemPrompt: ['scp-sp-ov-sysprompt'],
    connectionSource: ['scp-sp-ov-conn-source'],   customUrl: ['scp-sp-ov-custom-url'],
    customKey: ['scp-sp-ov-custom-key'],           customModel: ['scp-sp-ov-custom-model'],
    connectionProfileId: ['scp-sp-ov-conn-profile'],
    includeSystemPrompt: ['scp-sp-ov-include-sysprompt'], includeUserPersonality: ['scp-sp-ov-include-persona'],
    includeAlternateSwipes: ['scp-sp-ov-include-alt-swipes'], applyRegexToContext: ['scp-sp-ov-apply-regex'],
    charEditAIEnabled: ['scp-sp-ov-char-edit-enabled'], charEditPrompt: ['scp-sp-ov-char-edit-prompt'],
    lorebookAIManageEnabled: ['scp-sp-ov-lb-ai-enabled'], lorebookManagePrompt: ['scp-sp-ov-lb-manage-prompt'],
    lorebookAutoKeyword: ['scp-sp-ov-lb-auto-kw'], chatEditAIEnabled: ['scp-sp-ov-chat-edit-enabled'],
    chatEditPrompt: ['scp-sp-ov-chat-edit-prompt'],
    charField_tags: ['scp-sp-ov-ce-tags'],                 charField_description: ['scp-sp-ov-ce-description'],
    charField_personality: ['scp-sp-ov-ce-personality'],   charField_scenario: ['scp-sp-ov-ce-scenario'],
    charField_first_mes: ['scp-sp-ov-ce-first-mes'],       charField_mes_example: ['scp-sp-ov-ce-mes-example'],
    charField_authors_note: ['scp-sp-ov-ce-authors-note'], charField_system_prompt: ['scp-sp-ov-ce-system-prompt'],
    charField_post_history_instructions: ['scp-sp-ov-ce-post-history'],
    charField_alternate_greetings: ['scp-sp-ov-ce-alt-greetings'],
    forceStreaming: [],
};

// Profile keys
export const _PROFILE_KEYS = [
    ..._SETTINGS_DEF.filter(d => d.profileKey).map(d => d.key),
    'includeAuthorsNote', 'includeCharacterCard'
];
