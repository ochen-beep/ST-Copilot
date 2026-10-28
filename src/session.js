// Facade over the session submodule split (session-settings /
// session-storage / session-crud). Historical import sites (api.js, index.js,
// ui modules, feature modules, tests — including dynamic import('./session.js')
// call sites) keep importing everything from here.
// Mutable storage state (_inMemoryBucket, _currentSessionFileId, _saveQueue,
// _bucketInitEpoch, _filesWithContent) lives only in session-storage.js.
export {
    getSettings,
    saveSettings,
    getBindingKey,
    getStableCharId,
    expandMacros,
    getSessionFavKey,
    getStarredMessages,
    isMessageStarred,
    toggleStarMessage,
} from './session-settings.js';

export {
    saveSessionFile,
    deleteSessionFile,
    loadSessionFile,
    initChatBucket,
    commitBucketChanges,
    saveSessionsToMetadata,
    getChatBucket,
} from './session-storage.js';

export {
    getSessionOverrides,
    getEffectiveSettings,
    setSessionOverride,
    clearAllSessionOverrides,
    hasSessionOverrides,
    genId,
    createSession,
    getActiveSession,
    setActiveSession,
    deleteCurrentSession,
    getCurrentSession,
    addMessage,
    truncateAfter,
    deleteMsg,
    truncateFrom,
    exportCurrentSession,
    importSession,
    showSessionDialog,
} from './session-crud.js';
