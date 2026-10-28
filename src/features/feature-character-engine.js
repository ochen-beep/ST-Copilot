// Facade over the character-engine submodule split (-context / -parse /
// -apply). Historical import sites (api.js, prompt-builder.js,
// request-inspector.js, ui modules, feature-character-ui, tests) keep
// importing everything from here.
export {
    getEffectiveCharField,
    isCharacterExcluded,
    setCharacterExcluded,
    getCharFieldOverride,
    setCharFieldOverride,
    getEffectiveCharFieldForChar,
    getActiveCharacterEntities,
    buildCharacterContextBlock,
    buildCharEditAIInstructions,
    resolveCharacterByName,
    groupChangesByCharacter,
} from './feature-character-engine-context.js';

export {
    parseCharChangesFromText,
    _repairCharChangesXML,
    stripCharChangesBlock,
    parseCharCreationFromText,
    stripCharCreationBlock,
} from './feature-character-engine-parse.js';

export {
    getCharFieldValue,
    saveCharacterField,
    createCharacterAPI,
} from './feature-character-engine-apply.js';
