export const state = {
    generating: false,
    copilotActive: false,
    configDirty: false,
    themeDirty: false,
    activeToolCalls: [],
    searchQuery: '',
    searchMatches: [],
    searchIdx: -1,
    searchOpen: false,
    searchWholeWord: false,
    pendingAttachments: [],
    lbActiveBook: null,
    lbSearchQuery: '',
    lbEntryDetailEntry: null,
    lbEntryDetailBook: null,
    lastChatLen: -1,
    userScrolledUp: false,
    savedScrollTop: 0,
    abortController: null,
    htmlBlockCounter: 0,
    htmlBlockRegistry: new Map(),
    tokenCountCache: new Map(),
    tokenCountPromises: new Map(),

    // Кэш системного промпта buildSystemContent() с dirty-flag инвалидацией.
    // buildSystemContent фактически пересобирает async лорбук-контекст (fetch WI на
    // каждую активную книгу), и в типовой одной генерации он вызывается минимум дважды
    // (assembleMessages для fullPromptText и сама отправка). Кэшируем Promise, чтобы:
    //   - между инвалидациями пересборка шла ровно 1 раз за эпоху;
    //   - конкурентные вызовы делали 1 асинхронную работу, а не N.
    //   _systemPromptCache        : Promise<string> | null
    //   _systemPromptSig          : 8-симв. hex подпись relevant-inputs (лёгкая страховка
    //                                от забытого invalidate; см. _computeSystemPromptSignature
    //                                в api.js).
    //   _systemPromptDirty        : true → следующий вызов точно пересоберёт промпт.
    //   _systemPromptEpoch        : монотонно растёт на каждой инвалидации (отладка/метрики).
    systemPromptCache: null,
    systemPromptSig: null,
    systemPromptDirty: true,
    systemPromptEpoch: 0,

    // Сообщение/прогресс последней инвалидации (для _dbgAdd в invalidate-обёртке).
    systemPromptInvalidateReason: 'init'
};

/**
 * Поднимает dirty-флаг кэша системного промпта и обнуляет закэшированный Promise.
 * Дёргано точечно из тех мест, что меняют любой вход, формирующий системный промпт:
 * настройки, памяти, активные лорбуки, чат/персонаж, выбор сессии, bucket load/recovery.
 * Безопасна для повторного вызова; возраст _epoch растёт при каждом вызове.
 *
 * @param {string} [reason] — короткое описание источника инвалидации (для _dbgAdd).
 */
export function invalidateSystemPromptCache(reason = 'unspec') {
    state.systemPromptDirty = true;
    state.systemPromptEpoch = (state.systemPromptEpoch + 1) >>> 0;
    state.systemPromptCache = null;
    state.systemPromptSig = null;
    state.systemPromptInvalidateReason = String(reason);
}

/**
 * Чистая функция принятия решения о применении кэша системного промпта.
 * Экспортирована отдельно, чтобы можно было unit-тестировать логику не подтягивая
 * ST-контекст и не запуская пересборку промпта.
 *
 * @param {object} st        — state-объект (с _systemPromptCache/_systemPromptSig/_systemPromptDirty)
 * @param {string} curSig    — подпись текущих входов, вычисленная до вызова кэша
 * @returns {{useCache: boolean, reason: string}}
 */
export function decideSystemPromptCache(st, curSig) {
    if (st.systemPromptDirty) return { useCache: false, reason: 'dirty-flag' };
    if (!st.systemPromptCache) return { useCache: false, reason: 'cache-empty' };
    if (st.systemPromptSig !== curSig) return { useCache: false, reason: 'sig-mismatch' };
    return { useCache: true, reason: 'hit' };
}

export const DBG_STATE = {
    log: [],
    MAX: 3000,
    sessionStart: new Date().toISOString(),
    snapshot: null,
    diffTid: null
};

export const DBG_SKIP = new Set([
    'customTheme','savedThemes','sessions','starredMessages',
    'stats','quickPromptSets','customSounds','completionSoundData',
    'quickPrompts','profiles','promptPresets','altGreetingIndices',
    'memories'
]);