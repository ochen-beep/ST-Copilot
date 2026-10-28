import { CHAR_EDIT_FORMAT_BLOCK, CHAR_CREATE_FORMAT_BLOCK, DEFAULT_CHAR_EDIT_DIRECTIVE, EXT_DISPLAY } from '../constants.js';
import { getSettings } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { escHtml } from '../utils/util-dom.js';
import { _ensureWrapped, levenshtein } from '../utils/util-text.js';
import { getTagsForCharacter, getAuthorsNote } from '../utils/util-st.js';
import { _getAspectEvolutiaCharFields, _getAspectEvolutiaPersonaFields } from '../integrations/integ-evolutia.js';

export function getEffectiveCharField(settings, k) {
    const ovKey = 'charField_' + k;
    if (settings[ovKey] !== undefined) return settings[ovKey];
    return !!(settings.charEditFields || {})[k];
}

export function isCharacterExcluded(settings, charId) {
    return (settings.charMgrExcluded || []).includes(charId);
}

export function setCharacterExcluded(settings, charId, excluded) {
    if (!Array.isArray(settings.charMgrExcluded)) settings.charMgrExcluded = [];
    const idx = settings.charMgrExcluded.indexOf(charId);
    if (excluded && idx === -1) settings.charMgrExcluded.push(charId);
    else if (!excluded && idx !== -1) settings.charMgrExcluded.splice(idx, 1);
}

export function getCharFieldOverride(settings, charId, field) {
    return (settings.charMgrFieldOverrides || {})[charId]?.[field];
}

export function setCharFieldOverride(settings, charId, field, value) {
    if (!settings.charMgrFieldOverrides) settings.charMgrFieldOverrides = {};
    if (!settings.charMgrFieldOverrides[charId]) settings.charMgrFieldOverrides[charId] = {};
    if (value === undefined) delete settings.charMgrFieldOverrides[charId][field];
    else settings.charMgrFieldOverrides[charId][field] = value;
}

export function getEffectiveCharFieldForChar(settings, charId, field) {
    const ov = getCharFieldOverride(settings, charId, field);
    return ov !== undefined ? ov : getEffectiveCharField(settings, field);
}

export function getActiveCharacterEntities() {
    const ctx = SillyTavern.getContext();
    const entities = [];
    const seen = new Set();
    const pushChar = char => {
        if (char && !seen.has(char.avatar)) {
            seen.add(char.avatar);
            entities.push({ id: char.avatar, name: char.name, avatar: char.avatar, char, isPersona: false });
        }
    };

    if (ctx.groupId) {
        const group = (ctx.groups || []).find(g => g.id === ctx.groupId);
        (group?.members || []).forEach(m => {
            const avatarId = typeof m === 'string' ? m : (m?.avatar || m?.id);
            pushChar((ctx.characters || []).find(c => c.avatar === avatarId));
        });
    } else {
        pushChar(ctx.characters?.[ctx.characterId]);
    }
    return entities;
}
function buildSingleCharacterBlock(settings, entity) {
    const ctx = SillyTavern.getContext();
    const { char, id: charId } = entity;
    const d = char.data || {};
    const parts = [];
    const eff = field => getEffectiveCharFieldForChar(settings, charId, field);

    const charTags = getTagsForCharacter(char);
    if (eff('tags') && charTags.length) parts.push(`<tags>\n${charTags.join(', ')}\n</tags>`);

    const sysPrompt = d.system_prompt || char.system_prompt;
    if (eff('system_prompt') && sysPrompt) parts.push(`<character_system_prompt_override>\n${sysPrompt}\n</character_system_prompt_override>`);

    const postHist = d.post_history_instructions || char.post_history_instructions;
    if (eff('post_history_instructions') && postHist) parts.push(`<post_history_instructions>\n${postHist}\n</post_history_instructions>`);

    const simple = {
        description: d.description || char.description,
        personality: d.personality || char.personality,
        scenario: d.scenario || char.scenario,
        first_mes: d.first_mes || char.first_mes,
        mes_example: d.mes_example || char.mes_example,
    };

    const isMainChar = char.avatar === ctx.characters?.[ctx.characterId]?.avatar;
    if (isMainChar && getSettings().useAspectEvolutia) {
        const aeFields = _getAspectEvolutiaCharFields();
        if (aeFields && aeFields.length) {
            delete simple.description;
            aeFields.forEach(f => parts.push(`<evolutia_char_field name="${escHtml(f.name)}">\n${f.content}\n</evolutia_char_field>`));
        }
    }

    for (const [key, val] of Object.entries(simple)) {
        if (eff(key) && val) parts.push(`<${key}>\n${val}\n</${key}>`);
    }

    if (eff('alternate_greetings') && Array.isArray(d.alternate_greetings) && d.alternate_greetings.length) {
        const agMap = settings.altGreetingIndices || {};
        const indices = Array.isArray(agMap[charId]) ? agMap[charId] : d.alternate_greetings.map((_, i) => i);
        const filtered = indices.filter(i => i >= 0 && i < d.alternate_greetings.length);
        if (filtered.length) {
            const gs = filtered.map(i => `  <greeting id="${i+1}">\n${d.alternate_greetings[i]}\n  </greeting>`).join('\n');
            parts.push(`<alternate_greetings>\n${gs}\n</alternate_greetings>`);
        }
    }

    if (eff('authors_note')) {
        const an = getAuthorsNote();
        if (an) parts.push(`<authors_note>\n${an}\n</authors_note>`);
    }

    if (!parts.length) return '';
    return `<character name="${escHtml(char.name)}">\n${parts.join('\n\n')}\n</character>`;
}

export function buildCharacterContextBlock(settings) {
    const entities = getActiveCharacterEntities();
    if (!entities.length) return '';
    const excluded = new Set(settings.charMgrExcluded || []);
    const blocks = entities
        .filter(ent => !excluded.has(ent.id))
        .map(ent => buildSingleCharacterBlock(settings, ent))
        .filter(Boolean);
    if (!blocks.length) return '';
    return `<characters>\n${blocks.join('\n\n')}\n</characters>`;
}

export function buildCharEditAIInstructions(settings) {
    if (!settings.charEditAIEnabled) return '';
    const baseFields = ['name', 'tags', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'authors_note', 'alternate_greetings', 'system_prompt', 'post_history_instructions'];
    const fieldsList = baseFields.filter(k => k === 'name' || getEffectiveCharField(settings, k));

    if (settings.includeUserPersonality && !fieldsList.includes('user_persona')) {
        fieldsList.push('user_persona');
    }
    const enabledFields = fieldsList.join(', ') || 'all fields';

    const aeCharFields = settings.useAspectEvolutia ? _getAspectEvolutiaCharFields() : null;
    const aeUserFields = settings.useAspectEvolutia && settings.includeUserPersonality ? _getAspectEvolutiaPersonaFields() : null;

    let evolutiaDocs = '';
    if (aeCharFields || aeUserFields) {
        evolutiaDocs = `\n\n<aspect_evolutia_integration>\nDynamic fields are currently managing descriptions. To edit them, target their specific virtual names.\n`;
        if (aeCharFields && aeCharFields.length) {
            evolutiaDocs += `Character Aspect Fields:\n` + aeCharFields.map(f => `- Field: "evolutia_char:${f.name}"`).join('\n') + `\n`;
        }
        if (aeUserFields && aeUserFields.length) {
            evolutiaDocs += `User Aspect Fields:\n` + aeUserFields.map(f => `- Field: "evolutia_user:${f.name}"`).join('\n') + `\n`;
        }
        evolutiaDocs += `Example: <replace field="evolutia_char:FieldName">...</replace>\n</aspect_evolutia_integration>`;
    }

    const base = (settings.charEditPrompt || DEFAULT_CHAR_EDIT_DIRECTIVE.trim())
        .replace('{{char_edit_fields}}', enabledFields)
        .replace('{{char_edit_format}}', CHAR_EDIT_FORMAT_BLOCK)
        .replace('{{char_create_format}}', CHAR_CREATE_FORMAT_BLOCK);

    return _ensureWrapped(`${base}${evolutiaDocs}`, 'character_management');
}

export function resolveCharacterByName(aiName, entities = null) {
    if (!aiName) return null;
    const ctx = SillyTavern.getContext();
    const list = entities || getActiveCharacterEntities();
    if (!list.length) return null;

    const normAi = aiName.toLowerCase().trim();
    let found = list.find(e => e.char.name === aiName)
        || list.find(e => e.char.name.toLowerCase().trim() === normAi);
    if (found) return found.char;

    // В группе неточное имя = отказ, а не чужая карточка.
    if (list.length > 1) return null;

    // Одиночный чат: цель одна, мягкие проходы не могут промахнуться в чужую карту.
    found = list.find(e => {
        const n = e.char.name.toLowerCase().trim();
        return n.includes(normAi) || normAi.includes(n);
    });
    if (found) return found.char;

    if (normAi !== (ctx.name1 || '').toLowerCase().trim()) return list[0].char;

    let best = null, bestDist = Infinity;
    for (const e of list) {
        const dist = levenshtein(normAi, e.char.name.toLowerCase().trim());
        if (dist < bestDist) { bestDist = dist; best = e.char; }
    }
    return (best && bestDist <= 2) ? best : null;
}

export function groupChangesByCharacter(changes) {
    const entities = getActiveCharacterEntities();
    const groups = new Map();

    for (const change of changes) {
        let resolvedChar = change.char ? resolveCharacterByName(change.char, entities) : null;
        if (!resolvedChar && entities.length === 1) resolvedChar = entities[0].char;
        if (!resolvedChar) {
            // ponytail: в группе не угадываем автора правки — модель должна
            // назвать персонажа точно; правка без адресата отклоняется.
            _dbgAdd('CHAR_EDIT_UNRESOLVED', { changeChar: change.char || null, field: change.field });
            if (typeof toastr !== 'undefined') {
                toastr.warning(`[Карточки] Правка поля «${change.field}» пропущена: персонаж «${change.char}» не найден в группе. Назовите персонажа точно.`, EXT_DISPLAY, { timeOut: 8000 });
            }
            continue;
        }
        const key = resolvedChar.avatar;
        if (!groups.has(key)) groups.set(key, { char: resolvedChar, changes: [] });
        groups.get(key).changes.push(change);
    }
    return Array.from(groups.values());
}
