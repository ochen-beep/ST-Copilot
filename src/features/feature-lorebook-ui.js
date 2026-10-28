// Facade over the lorebook UI submodule split (apply/history, proposal card,
// manager overlay). Historical import sites (ui-chat submodules, index.js,
// feature-chatedit/character UI, ui-settings) keep importing everything from
// here.
export {
    reconstructLBChangesBlock,
    openDiffModal,
    renderLBHistoryContent,
    appendLBHistoryEl,
    logLBHistoryChanges,
    applyLBChanges,
} from './feature-lorebook-ui-apply.js';

export {
    renderProposalCard,
} from './feature-lorebook-ui-proposals.js';

export {
    openLorebookManager,
    closeLorebookManager,
    _applyLBBookCheckState,
    refreshLorebookList,
    toggleLorebookSelection,
    viewLorebookEntries,
    renderEntryList,
    cycleEntryOverride,
    showEntryDetail,
    saveEntryDetail,
    deleteEntryDetail,
    addNewEntry,
    updateLBFooterInfo,
    setupLorebookManagerListeners,
} from './feature-lorebook-ui-manager.js';
