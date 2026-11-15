import { _dbgAdd } from './util-debug.js';

// Анти-флуд: циклы применений патчей (валидация/preview карточки чат-эдита,
// exec bulk_replace, лорбук-apply) гоняют десятки якорей по десяткам полей за
// один тик — построчные записи каждого промаха за ~20 мс вытесняли из
// дебаг-кольца (3000) всё остальное (дамп 2026-11-15: 260+ записей, ни одного
// TOOL_*/GEN_* события не выжило). Промахи одного синхронного окна агрегируются
// в одну сводку; окно закрывается микротаском — циклы, разбитые await'ами,
// дают по сводке на сегмент. Одиночный промах пишется в старой форме.
let _missAgg = null;

function _logReplaceMiss(reason, search, srcLength) {
    const sample = { search: String(search).slice(0, 120), reason: String(reason).slice(0, 120), srcLength };
    if (_missAgg) {
        _missAgg.misses++;
        _missAgg.fields.add(srcLength);
        if (_missAgg.samples.length < 8) _missAgg.samples.push(sample);
        return;
    }
    const agg = { misses: 1, fields: new Set([srcLength]), samples: [sample] };
    _missAgg = agg;
    queueMicrotask(() => {
        if (_missAgg === agg) _missAgg = null;
        if (agg.misses === 1) {
            _dbgAdd('TEXT_REPLACE_FAILED', agg.samples[0]);
        } else {
            _dbgAdd('TEXT_REPLACE_FAILED', {
                aggregated: true,
                misses: agg.misses,
                fields: agg.fields.size,
                samples: agg.samples,
            });
        }
    });
}

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

// Per-char anchor normalization: case, ё→е, quote variants («» „ “ ” ' ') →
// straight quote, dash variants (– — − ‑) → hyphen. Models quote the source
// text in a different glyph form than the field actually stores (RU text is
// full of ё/е and «» drift), so plain indexOf misses valid patches.
function _normalizeAnchorChar(ch) {
    const c = ch.normalize('NFC').toLowerCase();
    if (c === 'ё') return 'е';
    if ('«»“”„‟‘’‚‛\''.includes(c)) return '"';
    if ('‐‑‒–—−-'.includes(c)) return '-';
    return c;
}

// ponytail: normalization folded into _findAllRanges (per code point, 1:1);
// no cross-char NFC composition / grapheme clustering — upgrade path:
// Intl.Segmenter position map like Diegetic's anchor.js if misses show.

// Все вхождения якоря: literal → whitespace-толерантный (переносы строк и
// кратные пробелы внутри якоря) → нормализованный (регистр, ё/е, кавычки,
// тире). Никакого прочего фаззи-подбора.
function _findAllRanges(src, query) {
    const q = query.trim();
    if (!q) return [];

    const out = [];
    let idx = src.indexOf(q);
    while (idx !== -1) {
        out.push({ start: idx, end: idx + q.length });
        idx = src.indexOf(q, idx + 1);
    }
    if (out.length) return out;

    const parts = q.split(/\s+/).map(_escapeRe);
    if (parts.length >= 2) {
        const wsRe = new RegExp(parts.join('\\s+'), 'g');
        let m;
        while ((m = wsRe.exec(src)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
        if (out.length) return out;
    }

    // Нормализованный проход: якорь в другой форме юникода (ё/е, «» vs "",
    // тире, NBSP, регистр). Нормализация — 1:1 на кодовую точку, поэтому
    // совпадение ищется по массиву нормализованных символов и проецируется
    // обратно на исходные индексы — заменяется исходный спан.
    // ponytail: O(n·m) скан на промахе — поля лорбука/сообщения малы;
    // KMP по нормализованному массиву, если когда-нибудь станет медленно.
    const hsEntries = [];
    const hsMap = [];
    let lastWasSpace = false;
    let srcIdx = 0;
    for (const ch of src) {
        if (/\s/.test(ch)) {
            if (!lastWasSpace) { hsEntries.push(' '); hsMap.push(srcIdx); lastWasSpace = true; }
            srcIdx += ch.length;
            continue;
        }
        lastWasSpace = false;
        hsEntries.push(_normalizeAnchorChar(ch));
        hsMap.push(srcIdx);
        srcIdx += ch.length;
    }
    const nqEntries = [];
    let nqLastSpace = false;
    for (const ch of q) {
        if (/\s/.test(ch)) {
            if (!nqLastSpace) { nqEntries.push(' '); nqLastSpace = true; }
            continue;
        }
        nqLastSpace = false;
        nqEntries.push(_normalizeAnchorChar(ch));
    }
    if (!nqEntries.length) return out;

    for (let start = 0; start + nqEntries.length <= hsEntries.length; start++) {
        let ok = true;
        for (let j = 0; j < nqEntries.length; j++) {
            if (hsEntries[start + j] !== nqEntries[j]) { ok = false; break; }
        }
        if (!ok) continue;
        const endEntry = start + nqEntries.length;
        const start0 = hsMap[start];
        const end0 = endEntry >= hsMap.length ? src.length : hsMap[endEntry];
        out.push({ start: start0, end: end0 });
    }
    return out;
}

// Уникальное вхождение. Возвращает { start, end } | { ambiguous: true, count } | null.
function _findUniqueRange(src, query) {
    const all = _findAllRanges(src, query);
    if (all.length === 1) return all[0];
    if (all.length > 1) return { ambiguous: true, count: all.length };
    return null;
}

export function applySearchReplaceToField(fieldContent, searchText, replaceText) {
    if (!fieldContent) return { result: replaceText || '', matched: true };
    const src = fieldContent;
    const srch = searchText || '';
    const repl = replaceText || '';

    const fail = (reason) => {
        _logReplaceMiss(reason, srch, src.length);
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
    if (m?.ambiguous) {
        const f = fail(`якорь «${srch.trim().slice(0, 60)}» встречается ${m.count} раза — включи в якорь больше контекста или замени все вхождения`);
        f.occurrences = m.count;
        return f;
    }
    if (m) return { result: src.slice(0, m.start) + repl + src.slice(m.end), matched: true };

    return fail('якорь не найден — запроси точный текст поля инструментом чтения и процитируй его дословно');
}

// Замена ВСЕХ вхождений якоря (режим patch.all): для «переименуй таверну везде».
// Диапазонные якоря «a || b» не поддерживаются — у них нет однозначного «всех».
export function applyReplaceAllToField(fieldContent, searchText, replaceText) {
    const src = fieldContent || '';
    const srch = (searchText || '').trim();
    const repl = replaceText || '';
    if (!srch) return { result: src, matched: false, count: 0, reason: 'пустой якорь' };
    if (srch.includes('||') || srch.includes('...')) {
        return { result: src, matched: false, count: 0, reason: 'диапазонный якорь не поддерживает замену всех вхождений' };
    }
    const all = _findAllRanges(src, srch);
    if (!all.length) return { result: src, matched: false, count: 0, reason: 'якорь не найден' };
    // Собираем с конца, чтобы индексы не съезжали.
    let result = src;
    for (let i = all.length - 1; i >= 0; i--) {
        result = result.slice(0, all[i].start) + repl + result.slice(all[i].end);
    }
    return { result, matched: true, count: all.length };
}

// Единая точка применения одного патча: нормализует ключи (search/anchor)
// и режим all. Использовать везде вместо прямых вызовов applySearchReplaceToField.
export function applyPatchToField(content, patch) {
    const search = patch?.search || patch?.anchor || '';
    const replace = patch?.replace || '';
    return patch?.all === true
        ? applyReplaceAllToField(content, search, replace)
        : applySearchReplaceToField(content, search, replace);
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
// ─── Proposal block parsing helpers ─────────────────────────────────────────
// The model sometimes escapes fence markers (\`\`\`) and quotes (\") inside
// proposal blocks when the chat system prompt demonstrates escaped formatting
// itself — parsers then miss the block entirely and the user gets unappliable
// changes. Fence regexes tolerate an optional backslash before every backtick;
// JSON bodies get an unescape pass on top of the structural repair.

export function proposalFenceBodyRegex(tag) {
    // Single lazy match covering both closed and unclosed blocks: body runs
    // until the next fence (plain or escaped) or end of text.
    return new RegExp('(?:\\\\?`){3}' + tag + '\\s*([\\s\\S]*?)(?=(?:\\\\?`){3}|$)');
}

export function proposalStripRegexes(tag) {
    const fence = '(?:\\\\?`){3}';
    return {
        closed: new RegExp(fence + tag + '[\\s\\S]*?' + fence, 'g'),
        open: new RegExp(fence + tag + '[\\s\\S]*', 'g'),
    };
}

// JSON.parse -> unescape \" and \\ -> structural repair on both variants.
export function parseLooseJSON(raw) {
    const candidates = [raw, raw.replace(/\\(["\\])/g, '$1')];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) {}
    }
    for (const candidate of candidates) {
        try {
            const repaired = JSON.parse(_repairJSON(candidate));
            if (repaired && typeof repaired === 'object') return repaired;
        } catch (_) {}
    }
    return null;
}
