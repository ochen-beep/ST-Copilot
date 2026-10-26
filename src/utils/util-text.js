import { _dbgAdd } from './util-debug.js';

/**
 * Итеративный Левенштейн с двумя строками-буферами (O(N) памяти).
 * Используется для мягкого подбора имени в resolveCharacterByName.
 */
export function levenshtein(a, b) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    let l1 = a.length, l2 = b.length;
    if (l1 === 0) return l2;
    if (l2 === 0) return l1;
    let prev = new Int32Array(l2 + 1);
    let curr = new Int32Array(l2 + 1);
    for (let j = 0; j <= l2; j++) prev[j] = j;
    for (let i = 1; i <= l1; i++) {
        curr[0] = i;
        for (let j = 1; j <= l2; j++) {
            const cost = (a.charAt(i - 1) === b.charAt(j - 1)) ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        const temp = prev; prev = curr; curr = temp;
    }
    return prev[l2];
}

export function _repairJSON(raw) {
    let s = raw;
    s = s.replace(/,\s*([\}\]])/g, '$1');
    try {
        s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
            const fixed = inner.replace(/(?<!\\)"/g, '\\"');
            return `"${fixed}"`;
        });
    } catch (_) {}
    const opens = (s.match(/[\[{]/g) || []).length;
    const closes = (s.match(/[\]\}]/g) || []).length;
    if (opens > closes) {
        const stack = [];
        for (const ch of s) {
            if (ch === '{') stack.push('}');
            else if (ch === '[') stack.push(']');
            else if (ch === '}' || ch === ']') stack.pop();
        }
        s += stack.reverse().join('');
    }
    return s;
}

export function _sanitizeProposedTags(value) {
    if (typeof value !== 'string') return '';
    let cleaned = value.trim();
    
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            return parsed.map(t => String(t).trim()).filter(Boolean).join(', ');
        }
        if (typeof parsed === 'string') {
            cleaned = parsed.trim();
        }
    } catch (_) {}

    cleaned = cleaned.replace(/^\[\s*|\]\s*$/g, '').trim();

    const quotedMatches = [...cleaned.matchAll(/["']([^"']+)["']/g)].map(m => m[1].trim());
    if (quotedMatches.length > 0) {
        return quotedMatches.filter(Boolean).join(', ');
    }

    return cleaned.split(',')
        .map(item => item.replace(/[\[\]"']/g, '').trim())
        .filter(Boolean)
        .join(', ');
}

export function normalizeCharNamesInBlock(text) {
    const ctx = SillyTavern.getContext();
    const charName = ctx.characters?.[ctx.characterId]?.name;
    const userName = ctx.name1;
    // \b не работает с кириллицей (в JS \w = [A-Za-z0-9_]), поэтому границы
    // «целого слова» строим на Unicode-классах букв/цифр.
    const wordRe = (name) => new RegExp(
        `(?<![\\p{L}\\p{N}_])${_escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'giu'
    );
    return text.replace(/(```(?:character-changes|character-create)[\s\S]*?(?:```|$))/g, block => {
        let r = block;
        if (charName && charName.length > 2) {
            r = r.replace(wordRe(charName), '{{char}}');
        }
        if (userName && userName.length > 2) {
            r = r.replace(wordRe(userName), '{{user}}');
        }
        return r;
    });
}

function _escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Уникальное вхождение: literal → whitespace-толерантный (переносы строк и
// кратные пробелы внутри якоря). Никакого фаззи-подбора: правка либо ложится
// точно и однозначно, либо не ложится вовсе.
// Возвращает { start, end } | { ambiguous: true } | null.
function _findUniqueRange(src, query) {
    const q = query.trim();
    if (!q) return null;

    let first = src.indexOf(q);
    if (first !== -1) {
        if (src.indexOf(q, first + 1) !== -1) return { ambiguous: true };
        return { start: first, end: first + q.length };
    }

    const parts = q.split(/\s+/).map(_escapeRe);
    if (parts.length < 2) return null;
    const wsRe = new RegExp(parts.join('\\s+'), 'g');
    const m1 = wsRe.exec(src);
    if (!m1) return null;
    if (wsRe.exec(src)) return { ambiguous: true };
    return { start: m1.index, end: m1.index + m1[0].length };
}

export function applySearchReplaceToField(fieldContent, searchText, replaceText) {
    if (!fieldContent) return { result: replaceText || '', matched: true };
    const src = fieldContent;
    const srch = searchText || '';
    const repl = replaceText || '';

    const fail = (reason) => {
        _dbgAdd('TEXT_REPLACE_FAILED', { reason, search: srch.slice(0, 120), srcLength: src.length });
        return { result: src, matched: false, reason };
    };

    if (!srch.trim()) return fail('пустой якорь');

    // Диапазонный якорь "start || end" / "start ... end": снести всё между
    // однозначными началом и концом. Не сошёлся — падаем в общий поиск ниже.
    let sepIdx = srch.indexOf(' || ');
    let sepLen = 4;
    if (sepIdx === -1) { sepIdx = srch.indexOf('||'); sepLen = 2; }
    if (sepIdx === -1) { sepIdx = srch.indexOf('...'); sepLen = 3; }

    if (sepIdx > 0 && srch.length - sepIdx - sepLen > 0) {
        const startPart = srch.slice(0, sepIdx).trim();
        const endPart = srch.slice(sepIdx + sepLen).trim();

        if (startPart && endPart) {
            const s = _findUniqueRange(src, startPart);
            if (s?.ambiguous) return fail(`начало якоря «${startPart.slice(0, 60)}» встречается несколько раз — уточни его`);
            if (s) {
                const e = _findUniqueRange(src.slice(s.end), endPart);
                if (e?.ambiguous) return fail(`конец якоря «${endPart.slice(0, 60)}» встречается несколько раз — уточни его`);
                if (e) {
                    const absEnd = s.end + e.end;
                    return { result: src.slice(0, s.start) + repl + src.slice(absEnd), matched: true };
                }
            }
        }
    }

    const m = _findUniqueRange(src, srch);
    if (m?.ambiguous) return fail(`якорь «${srch.trim().slice(0, 60)}» встречается несколько раз — включи в якорь больше контекста`);
    if (m) return { result: src.slice(0, m.start) + repl + src.slice(m.end), matched: true };

    return fail('якорь не найден — запроси точный текст поля инструментом чтения и процитируй его дословно');
}

export function _ensureWrapped(text, tag) {
    if (!text || !text.trim()) return '';
    let t = text.trim();
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    
    t = t.replace(new RegExp(`^<${tag}>\\s*`, 'i'), '');
    t = t.replace(new RegExp(`\\s*</${tag}>$`, 'i'), '');
    
    return `${open}\n${t}\n${close}`;
}