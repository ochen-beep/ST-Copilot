// Facade over the ui-chat submodule split (render/msg-actions/session-view/
// search/picker). Historical import sites (api.js, index.js, feature modules,
// ui-settings/ui-window) keep importing everything from here.
export {
    renderMarkdown,
    prepareHtmlForIframe,
    createHTMLBlockEl,
    postProcessHTMLBlocks,
    getDisplayContent,
    extractToolCallPlaceholders,
    _renderMsgBodyContent,
    _updateMsgTokenCount,
} from './render-msg.js';

export {
    getLastAssistantMsgId,
    getSwipesForMsg,
    navigateSwipe,
    updateSwipeBar,
    _runSwipeRegen,
    _refreshSwipeBars,
    _refreshContinueBtns,
    scrollToBottom,
    saveScrollPosition,
    restoreScrollPosition,
    smartScrollToBottom,
    setupMessagesScrollTracking,
    setupCodeBlockActions,
    addHistoryToSwipe,
    handleCopy,
    handleEdit,
    handleMessageRegen,
    handleDelete,
} from './msg-actions.js';

export {
    renderSession,
    appendMsgEl,
    removeMsgEl,
    removeMsgElAndBelow,
    removeMsgElAfter,
    updateMsgCount,
    updateDepthSlidersMax,
    setGeneratingState,
    showGenerationError,
    onChatChanged,
    setupDepthClickEdit,
    createMsgEl,
    setupMsgActionsDelegation,
} from './session-view.js';

export {
    openSearch,
    closeSearch,
    clearSearchHighlights,
    updateSearchCount,
    _applyHighlightsInRoot,
    performSearch,
    navigateSearch,
    toggleSearchWholeWord,
    setupSearchHotkey,
} from './search.js';

export {
    getPickedChatIndices,
    setPickedChatIndices,
    updatePickBtnState,
    openChatPicker,
    closeChatPicker,
    renderPickerMessages,
    _updatePickerCountEl,
    setupChatPickerListeners,
} from './chat-picker.js';
