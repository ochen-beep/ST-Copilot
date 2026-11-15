import { _sanitizeProposedTags, parseLooseJSON, proposalFenceBodyRegex, proposalStripRegexes } from '../utils/util-text.js';

function _parseTagAttrs(attrStr) {
    const attrs = {};
    // Модели пишут атрибуты с одинарными кавычками, без кавычек и лишними
    // пробелами вокруг «=» — принимаем все формы.
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(attrStr || '')) !== null) attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
    return attrs;
}

function _matchTagsWithAttrs(xml, tagName) {
    const re = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push({ attrs: _parseTagAttrs(m[1]), content: m[2] });
    return out;
}

// Модели называют поля карточек по-разному — сводим к внутренним id.
const FIELD_ALIASES = {
    first_message: 'first_mes', firstmessages: 'first_mes', greeting: 'first_mes', opening_message: 'first_mes',
    author_note: 'authors_note', author_s_note: 'authors_note', authorsnote: 'authors_note', note: 'authors_note',
    systemprompt: 'system_prompt', system: 'system_prompt',
    post_history: 'post_history_instructions', posthistory: 'post_history_instructions',
    desc: 'description',
    examples: 'mes_example', example_messages: 'mes_example', exampledialogue: 'mes_example',
    alternategreetings: 'alternate_greetings', alt_greetings: 'alternate_greetings',
    persona: 'user_persona', userdescription: 'user_persona',
};

function _normalizeFieldName(f) {
    const s = String(f || '').trim();
    if (!s) return '';
    if (/^evolutia_(char|user):/.test(s)) return s;
    const key = s.toLowerCase().replace(/[\s'’-]+/g, '_');
    return FIELD_ALIASES[key] || key;
}

// Имена proposal-блоков: промпт просит каноничное, старые промпты и модели
// пишут варианты — терпим их.
const CHAR_CHANGES_BLOCK = '(?:character-changes|character-edits?)(?![\\w-])';
const CHAR_CREATE_BLOCK = '(?:character-creation|character-create)(?![\\w-])';

export function parseCharChangesFromText(text) {
    const m = text.match(proposalFenceBodyRegex(CHAR_CHANGES_BLOCK));
    const raw = m ? m[1] : null;
    if (!raw) return null;
    // Attr values often arrive with escaped quotes (\"...\") when the model
    // imitates escaped formatting; unescape before the attribute parser.
    const xml = _repairCharChangesXML(raw.replace(/\\(["\\])/g, '$1'));
    const changes = [];

    const replaceByKey = {};
    for (const { attrs, content } of _matchTagsWithAttrs(xml, 'replace')) {
        const field = _normalizeFieldName(attrs.field);
        if (!field) continue;
        const charName = attrs.char || null;
        const index = attrs.index ? parseInt(attrs.index, 10) : undefined;
        const key = `${charName || ''}::${field}${index !== undefined ? `_${index}` : ''}`;

        const diffRe = /<<<<<<< (?:SEARCH|ANCHOR)\r?\n([\s\S]*?)\r?\n=+\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
        let diffMatch;
        const patches = [];
        while ((diffMatch = diffRe.exec(content)) !== null) {
            let searchVal = diffMatch[1];
            let replaceVal = diffMatch[2];
            if (field === 'tags') { searchVal = _sanitizeProposedTags(searchVal); replaceVal = _sanitizeProposedTags(replaceVal); }
            patches.push({ search: searchVal, replace: replaceVal });
        }
        if (!patches.length) {
            const searchOnly = content.match(/<<<<<<< (?:SEARCH|ANCHOR)\r?\n([\s\S]*?)\r?\n=+/);
            if (searchOnly) {
                let searchVal = searchOnly[1];
                if (field === 'tags') searchVal = _sanitizeProposedTags(searchVal);
                patches.push({ search: searchVal, replace: '' });
            }
        }
        if (!patches.length) {
            let val = content.trim();
            if (field === 'tags') val = _sanitizeProposedTags(val);
            const item = { field, action: 'overwrite', value: val, char: charName };
            if (index !== undefined) item.index = index;
            changes.push(item);
            continue;
        }
        if (!replaceByKey[key]) {
            const item = { field, action: 'replace', patches, char: charName };
            if (index !== undefined) item.index = index;
            replaceByKey[key] = item;
        } else {
            replaceByKey[key].patches.push(...patches);
        }
    }
    for (const item of Object.values(replaceByKey)) changes.push(item);

    for (const { attrs, content } of _matchTagsWithAttrs(xml, 'overwrite')) {
        const field = _normalizeFieldName(attrs.field);
        if (!field) continue;
        let val = content.trim();
        if (field === 'tags') val = _sanitizeProposedTags(val);
        const item = { field, action: 'overwrite', value: val, char: attrs.char || null };
        if (attrs.index) item.index = parseInt(attrs.index, 10);
        changes.push(item);
    }

    for (const { attrs, content } of _matchTagsWithAttrs(xml, 'append')) {
        const field = _normalizeFieldName(attrs.field);
        if (!field) continue;
        let val = content.trim();
        if (field === 'tags') val = _sanitizeProposedTags(val);
        changes.push({ field, action: 'append', value: val, char: attrs.char || null });
    }

    for (const { attrs, content } of _matchTagsWithAttrs(xml, 'prepend')) {
        const field = _normalizeFieldName(attrs.field);
        if (!field) continue;
        let val = content.trim();
        if (field === 'tags') val = _sanitizeProposedTags(val);
        const item = { field, action: 'prepend', value: val, char: attrs.char || null };
        if (attrs.index) item.index = parseInt(attrs.index, 10);
        changes.push(item);
    }

    for (const { attrs, content } of _matchTagsWithAttrs(xml, 'append_text')) {
        const field = _normalizeFieldName(attrs.field);
        if (!field) continue;
        let val = content.trim();
        if (field === 'tags') val = _sanitizeProposedTags(val);
        const item = { field, action: 'append_text', value: val, char: attrs.char || null };
        if (attrs.index) item.index = parseInt(attrs.index, 10);
        changes.push(item);
    }

    return changes.length ? changes : null;
}

export function _repairCharChangesXML(raw) {
    let s = raw;
    const TAGS = ['replace', 'overwrite', 'append_text', 'append', 'prepend'];

    for (const tag of TAGS) {
        const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g');
        const closeRe = new RegExp(`</${tag}>`, 'g');
        const parts = [];
        let lastIdx = 0;
        let openMatch;
        openRe.lastIndex = 0;
        const opens = [];
        while ((openMatch = openRe.exec(s)) !== null) opens.push(openMatch.index);

        if (opens.length === 0) continue;
        const closes = [];
        let cm;
        closeRe.lastIndex = 0;
        while ((cm = closeRe.exec(s)) !== null) closes.push(cm.index);

        if (opens.length <= closes.length) continue;

        const result = [];
        let cursor = 0;
        for (let i = 0; i < opens.length; i++) {
            const openStart = opens[i];
            const nextOpen = opens[i + 1] ?? Infinity;
            const closeAfterOpen = closes.find(ci => ci > openStart && ci < nextOpen);
            if (closeAfterOpen === undefined) {
                const insertAt = nextOpen === Infinity ? s.length : nextOpen;
                s = s.slice(0, insertAt) + `</${tag}>` + s.slice(insertAt);
                const shift = tag.length + 3;
                for (let j = i + 1; j < opens.length; j++) opens[j] += shift;
                for (let j = 0; j < closes.length; j++) { if (closes[j] >= insertAt) closes[j] += shift; }
                closes.push(insertAt);
                closes.sort((a, b) => a - b);
            }
        }
    }

    s = s.replace(/(<<<<<<< (?:SEARCH|ANCHOR)\r?\n[\s\S]*?)(?=<<<<<<< (?:SEARCH|ANCHOR)|$)/g, (m) => {
        if (!/=+\r?\n/.test(m) && !m.includes('=======')) return m + '\n=======\n>>>>>>> REPLACE\n';
        if (!m.includes('>>>>>>> REPLACE')) return m + '\n>>>>>>> REPLACE\n';
        return m;
    });

    return s;
}

export function stripCharChangesBlock(text) {
    const { closed, open } = proposalStripRegexes(CHAR_CHANGES_BLOCK);
    return text.replace(closed, '').replace(open, '').trim();
}

export function parseCharCreationFromText(text) {
    const m = text.match(proposalFenceBodyRegex(CHAR_CREATE_BLOCK));
    if (!m || !m[1].trim()) return null;
    const data = parseLooseJSON(m[1].trim());
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.tags) {
        data.tags = _sanitizeProposedTags(Array.isArray(data.tags) ? JSON.stringify(data.tags) : String(data.tags));
    }
    return data;
}

export function stripCharCreationBlock(text) {
    const { closed, open } = proposalStripRegexes(CHAR_CREATE_BLOCK);
    return text.replace(closed, '').replace(open, '').trim();
}
