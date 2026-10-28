import {
    EXT_NAME,
    EXT_DISPLAY,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_MEMORY_PROMPT,
    DEFAULT_LB_MANAGE_PROMPT,
    THEME_PRESETS
} from './constants.js';
import { _dbgDiffSettings } from './utils/util-debug.js';
import { invalidateSystemPromptCache } from './state.js';

// ─── Settings ───────────────────────────────────────────────────────────────
// Дефолты hoist'нуты на уровень модуля: getSettings() вызывается очень часто
// (каждый кадр физики лаунчера, каждый getEffectiveSettings, каждый recordStat),
// пересоздавать литерал из ~100 ключей на вызов — чистый churn.
const DEFAULT_SETTINGS = {
    enabled: true,
    performanceMode: true,
    windowVisible: false,
    minimized: false,
    windowX: null, windowY: null,
    windowW: 440, windowH: 600,
    opacity: 95,
    hotkey: 'Alt+Shift+C',
    hotkeyEnabled: true,
    searchHotkey: 'Ctrl+F',
    searchHotkeyEnabled: true,
    contextDepth: 15,
    localHistoryLimit: 50,
    connectionSource: 'default',
    connectionProfileId: '',
    customUrl: 'http://localhost:5000/v1',
    customKey: '',
    customModel: '',
    maxTokens: 8048,
    includeSystemPrompt: false,
    includeAuthorsNote: true,
    includeCharacterCard: true,
    includeUserPersonality: true,
    includeAlternateSwipes: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    memoryManagePrompt: DEFAULT_MEMORY_PROMPT,
    profiles: {},
    activeProfile: '',
    profileBindings: {},
    customTheme: { ...THEME_PRESETS.default },
    savedThemes: {},
    activeThemeProfile: '',
    sessions: {},
    lorebookEnabled: true,
    lorebookAutoKeyword: true,
    lorebookSelectedBooks: [],
    lorebookEntryOverrides: {},
    lorebookAIManageEnabled: true,
    lorebookManagePrompt: DEFAULT_LB_MANAGE_PROMPT,
    lorebookSTScanDepth: 5,
    lorebookCopilotScanDepth: 6,
    floatingIconPersistent: false,
    reasoningTrimStrings: '',
    ghostModeOpacity: 15,
    ghostModeHotkey: 'Alt+Shift+G',
    ghostModeHotkeyEnabled: true,
    quickPromptsVisible: false,
    quickPrompts: [
        { id: 'qp_d1', label: 'Анализ', icon: '🔍', text: 'Analyze the current scene and character motivations in detail.' },
        { id: 'qp_d2', label: 'Идеи', icon: '💡', text: 'Give me 3 creative plot twist ideas for the current scene.' },
        { id: 'qp_d3', label: 'Сводка', icon: '📋', text: 'Summarize everything that has happened in the roleplay so far.' },
        { id: 'qp_d4', label: 'Чувства', icon: '💭', text: 'What is {{char}} likely feeling right now and why?' },
        { id: 'qp_d5', label: 'Дальше?', icon: '🎯', text: 'What are the most interesting directions the story could go next?' },
    ],
    quickPromptSets: {},
    activeQuickPromptSet: '',
    promptPresets: {},
    stats: { g:{}, c:{}, ch:{} },
    changelogAutoShow: true,
    lastSeenVersion: '',
    starredMessages: {},
    forceStreaming: 'auto',
    applyRegexToContext: true,
    charEditAIEnabled: true,
    charEditPrompt: '',
    charEditFields: {
        tags: true, description: true, personality: true,
        scenario: true, first_mes: true, mes_example: true,
        alternate_greetings: false, authors_note: true,
        system_prompt: true, post_history_instructions: true, name: false,
    },
    completionSound: 'none',
    completionSoundVolume: 80,
    completionSoundOnlyWhenUnfocused: false,
    wobbleWindow: false,
    altGreetingIndices: [],
    chatEditAIEnabled: true,
    chatEditPrompt: '',
    lorebookExcludedBooks: [],
    pickerPreviewLines: 1,
    pickerPreviewLastLines: 0,
    imageAnalysisMode: 'direct',
    attachedFiles: [],
    memoryEnabled: true,
    memoryInject: true,
    memoryScope: 'global',
    memoryTag: 'memory-update',
    memoryNotify: true,
    memories: {},
    toolsEnabled: true,
    toolsThinking: false,
    toolsMaxRounds: 5,
    toolsProtocol: 'text',
    toolsEnabled_search_chat: true,
    toolsEnabled_search_lorebook: true,
    toolsEnabled_get_lorebooks: true,
    toolsEnabled_ask_user: true,
    toolsEnabled_get_char_info: true,
    toolsEnabled_get_chat_stats: true,
    toolsEnabled_get_recent_messages: true,
    toolsEnabled_read_url: true,
    toolsEnabled_search_web: true,
    toolsEnabled_todo_write: true,
    includeSummaryception: true,
    useAspectEvolutia: true,
    autoExpandMacros: false,
    includeHiddenMessages: false,
};
// Ключи с объектными/массивными значениями: при первом сидинге отдаём копию,
// чтобы последующие мутации settings не протекали в общий DEFAULT_SETTINGS.
const CLONED_DEFAULT_KEYS = new Set([
    'customTheme', 'profiles', 'profileBindings', 'sessions', 'lorebookSelectedBooks',
    'lorebookEntryOverrides', 'quickPrompts', 'quickPromptSets', 'promptPresets',
    'stats', 'starredMessages', 'charEditFields', 'altGreetingIndices',
    'attachedFiles', 'memories',
]);

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXT_NAME]) extensionSettings[EXT_NAME] = {};
    const s = extensionSettings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = CLONED_DEFAULT_KEYS.has(k) ? JSON.parse(JSON.stringify(v)) : v;
    }
    // v2.10.0+: launcherMode replaces the removed floating FAB setting.
    // Users who had the persistent floating icon get the floating launcher by default.
    if (s.launcherMode === undefined) {
        s.launcherMode = s.floatingIconPersistent ? 'floating' : 'bar';
    }
    return s;
}

export function saveSettings(opts = {}) {
    SillyTavern.getContext().saveSettingsDebounced();
    // quiet: для сохранений, которые не меняют ничего, влияющего на системный
    // промпт (статистика и т.п.) — не сбрасываем кэш промпта и не считаем diff.
    if (!opts.quiet) {
        _dbgDiffSettings();
        invalidateSystemPromptCache('saveSettings');
    }
}

// ─── ST Context Helpers ─────────────────────────────────────────────────────
export function getBindingKey() {
    const ctx = SillyTavern.getContext();
    let charId = 'global';
    if (ctx.characterId !== undefined && ctx.characterId !== null) {
        charId = String(ctx.characterId);
    } else if (typeof window.this_chid !== 'undefined' && window.this_chid !== null) {
        charId = String(window.this_chid);
    }

    let chatId = 'default';
    try {
        if (typeof window.chat_file_name === 'string' && window.chat_file_name) {
            chatId = String(window.chat_file_name);
        } else if (typeof ctx.getCurrentChatId === 'function') {
            const r = ctx.getCurrentChatId(); if (r) chatId = String(r);
        }

        if (chatId === 'default' || !chatId) {
            if (ctx.chatId) chatId = String(ctx.chatId);
            else if (typeof window.chat_id !== 'undefined' && window.chat_id !== null) chatId = String(window.chat_id);
        }
    } catch (_) {}

    return { charId, chatId };
}

// Stable per-character key for persisted data (memories, stats): the roster
// index shifts on delete/reorder, the avatar file name does not.
export function getStableCharId() {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    return char?.avatar || String(ctx.characterId ?? '');
}

// ─── Macro Expansion Helper ────────────────────────────────────────────────

export function expandMacros(text) {
    if (!text) return text;
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.substituteParams === 'function') {
            return ctx.substituteParams(text);
        }
        if (typeof window.substituteParams === 'function') {
            return window.substituteParams(text, ctx.name1, ctx.name2);
        }
    } catch (e) {
        console.warn(`[${EXT_DISPLAY}] Macro expansion error:`, e);
    }
    try {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        const d = char?.data || {};
        const now = new Date();
        return text
            .replace(/\{\{user\}\}/gi, ctx.name1 || 'User')
            .replace(/\{\{char\}\}/gi, char?.name || ctx.name2 || 'Character')
            .replace(/\{\{time\}\}/gi, now.toLocaleTimeString())
            .replace(/\{\{date\}\}/gi, now.toLocaleDateString())
            .replace(/\{\{isodate\}\}/gi, now.toISOString().split('T')[0])
            .replace(/\{\{isotime\}\}/gi, now.toTimeString().slice(0, 5))
            .replace(/\{\{lastMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                return msgs?.[msgs.length - 1]?.mes || '';
            })
            .replace(/\{\{lastUserMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                if (!msgs) return '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].is_user) return msgs[i].mes || '';
                }
                return '';
            })
            .replace(/\{\{lastCharMessage\}\}/gi, () => {
                const msgs = ctx.chat;
                if (!msgs) return '';
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (!msgs[i].is_user) return msgs[i].mes || '';
                }
                return '';
            })
            .replace(/\{\{description\}\}/gi, d.description || char?.description || '')
            .replace(/\{\{personality\}\}/gi, d.personality || char?.personality || '')
            .replace(/\{\{scenario\}\}/gi, d.scenario || char?.scenario || '');
    } catch (_) {
        return text;
    }
}

// ─── Starred Messages ───────────────────────────────────────────────────────

export function getSessionFavKey() {
    const { charId, chatId } = getBindingKey();
    return `${charId} ${chatId}`;
}

export function getStarredMessages() {
    const s = getSettings();
    const key = getSessionFavKey();
    if (!s.starredMessages[key]) s.starredMessages[key] = [];
    return s.starredMessages[key];
}

export function isMessageStarred(msgId) {
    return getStarredMessages().includes(msgId);
}

export function toggleStarMessage(msgId) {
    const s = getSettings();
    const key = getSessionFavKey();
    if (!s.starredMessages[key]) s.starredMessages[key] = [];
    const arr = s.starredMessages[key];
    const idx = arr.indexOf(msgId);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(msgId);
    saveSettings();
    return idx < 0; // true = now starred
}
