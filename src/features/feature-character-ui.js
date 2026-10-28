// Facade over the character-UI submodule split (-pickers / -apply / -cards).
// Historical import sites (ui/render-msg, msg-actions, session-view, search,
// chat-picker) and dynamic import sites (chat-shared.js featCharUiMod,
// ui-settings.js refreshAltGreetingsPickers) keep importing everything from
// here.
export {
    buildAltGreetingsPicker,
    refreshAltGreetingsPickers,
} from './feature-character-ui-pickers.js';

export {
    applyCharChanges,
    logCharEditHistory,
    logCharCreationHistory,
    reconstructCharChangesBlock,
} from './feature-character-ui-apply.js';

export {
    renderCharCreationCard,
    renderCharProposalCard,
} from './feature-character-ui-cards.js';
