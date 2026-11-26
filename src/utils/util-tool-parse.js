// Чистый парсер текстовых tool-протоколов: без импортов и ST-зависимостей,
// чтобы тесты и любые потребители не тянули граф движков/точку входа.

// Два текстовых протокола: ```tool_call фенсы (наш формат) и <tool_call> теги
// (Hermes-формат — его спонтанно эмитят модели, затюненные на function calling).
const TOOL_BLOCK_PATTERNS = [
    /```tool_call\n?([\s\S]*?)(?:```|$)/gi,
    /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi,
];

// Model-facing error for unparseable tool_call blocks: must name the real
// failure and the fix, otherwise the model concludes the tool environment is
// broken and abandons tools (answers from internal knowledge instead).
export const MALFORMED_TOOL_CALL_ERROR = 'Your tool_call block contained invalid JSON (unclosed quote or bracket, or wrong syntax) and was NOT executed. Re-emit the SAME call with strictly valid JSON: double quotes, escaped newlines inside strings, no trailing commas, all brackets closed.';

// ── JSON salvage ladder (ported from the DS-Comments parser) ────────────────
// Models routinely emit near-JSON: bare newlines inside strings, missing
// commas, trailing commas, single quotes, truncated braces. The ladder tries
// increasingly aggressive salvage before declaring the block malformed.

// Stateful, string-aware repair: escapes bare control chars inside strings,
// inserts missing commas between values, strips trailing commas.
// Byte-identical on valid JSON input.
function tryRepairJson(text) {
    const out = [];
    let inStr = false;
    let esc = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (esc) { out.push(ch); esc = false; continue; }
        if (ch === '\\' && inStr) { out.push(ch); esc = true; continue; }

        if (inStr) {
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
            // Raw control chars are illegal in JSON strings — escape them.
            if (ch < ' ') {
                if (ch === '\b') out.push('\\b');
                else if (ch === '\f') out.push('\\f');
                else out.push('\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
                continue;
            }

            if (ch === '"') {
                // Look ahead past whitespace to decide if this " closes the string
                let j = i + 1;
                while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
                const next = text[j];
                if (next === ',' || next === '}' || next === ']' || next === ':') {
                    inStr = false;
                    out.push(ch);
                    continue;
                }
                if (next === '"') {
                    // Another " follows → missing comma between values
                    inStr = false;
                    out.push(ch);
                    out.push(',');
                    continue;
                }
                inStr = false;
                out.push(ch);
                continue;
            }

            out.push(ch);
            continue;
        }

        if (ch === '"') { inStr = true; out.push(ch); continue; }

        // After } or ], insert missing comma before next value/key
        if (ch === '}' || ch === ']') {
            let j = i + 1;
            while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
            const next = text[j];
            if (next === '"' || next === '{' || next === '[') {
                out.push(ch);
                out.push(',');
                continue;
            }
        }

        out.push(ch);
    }

    let result = out.join('');
    return result.replace(/,(\s*[}\]])/g, '$1');
}

// Index of the matching brace/bracket for the opener at `start`
// (string and escape aware). -1 when unbalanced.
function findMatchingBrace(text, start) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === open) depth++;
        if (ch === close) {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

// Close still-open { [ in reverse order (string-aware scan). Returns the input
// unchanged when a closer has no opener — that head-cut is not salvageable here.
function closeUnbalancedBraces(text) {
    const stack = [];
    let inStr = false;
    let esc = false;
    for (const ch of text) {
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
        else if (ch === '}' || ch === ']') {
            if (stack[stack.length - 1] !== ch) return text;
            stack.pop();
        }
    }
    return stack.length ? text + stack.reverse().join('') : text;
}

// Single-quoted JSON variant: only worth trying when the block has no double
// quotes at all (guards against apostrophes inside prose values).
function singleQuoteVariant(text) {
    if (text.includes('"')) return null;
    return text.replace(/'/g, '"');
}

// Shape gate: a repair can yield valid JSON of the wrong shape — accept only
// plausible tool calls, escalate everything else to the next ladder rung.
function toToolCall(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const fn = (obj.function && typeof obj.function === 'object') ? obj.function : null;
    const name = (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim()
        : (fn && typeof fn.name === 'string' && fn.name.trim()) ? fn.name.trim()
        : null;
    if (!name) return null;
    let input = obj.input ?? obj.arguments ?? obj.parameters ?? fn?.arguments ?? {};
    if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch (_) { input = {}; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    return { name, input };
}

// All salvage variants of a block (quote conversion × brace closing × comma
// repair), each with its repaired form. Ladder steps try them in order.
function salvageVariants(text) {
    const variants = [text];
    const sq = singleQuoteVariant(text);
    if (sq !== null) variants.push(sq);
    const closed = closeUnbalancedBraces(text);
    if (closed !== text) variants.push(closed);
    if (sq !== null) {
        const sqClosed = closeUnbalancedBraces(sq);
        if (sqClosed !== sq) variants.push(sqClosed);
    }
    return variants.flatMap(v => [v, tryRepairJson(v)]);
}

function parseToolCallBlock(rawBlock) {
    if (!rawBlock) return [];

    // 1. Whole-block parse across all salvage variants.
    for (const candidate of salvageVariants(rawBlock)) {
        try {
            const parsed = JSON.parse(candidate);
            const calls = (Array.isArray(parsed) ? parsed : [parsed]).map(toToolCall).filter(Boolean);
            if (calls.length) return calls;
        } catch (_) {}
    }

    // 2. Per-object extraction: each {...} parsed independently, so one broken
    //    call no longer kills its siblings. Covers truncated tails too (an
    //    unclosed object is closed by closeUnbalancedBraces). A hopeless object
    //    with a recognizable name becomes a malformed entry — the model must
    //    learn that this specific call was NOT run, or it will wait for a
    //    result that never arrives.
    const extracted = [];
    let i = 0;
    while (i < rawBlock.length) {
        const start = rawBlock.indexOf('{', i);
        if (start === -1) break;
        const end = findMatchingBrace(rawBlock, start);
        const body = end !== -1 ? rawBlock.slice(start, end + 1) : rawBlock.slice(start);
        let parsed = false;
        for (const candidate of salvageVariants(body)) {
            try {
                const call = toToolCall(JSON.parse(candidate));
                if (call) {
                    if (!extracted.some(c => c.name === call.name && JSON.stringify(c.input) === JSON.stringify(call.input))) {
                        extracted.push(call);
                    }
                    parsed = true;
                    break;
                }
            } catch (_) {}
        }
        if (!parsed) {
            const nameMatch = body.match(/"name"\s*:\s*"([^"]+)"/);
            if (nameMatch) {
                extracted.push({ name: nameMatch[1], input: {}, malformed: true });
            }
        }
        i = (end !== -1 ? end : rawBlock.length) + 1;
    }
    if (extracted.length) return extracted;

    // 3. Name salvage: never dispatch a guessed call with silently empty input —
    //    flag it malformed so the model gets an actionable parse error.
    const nameMatch = rawBlock.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) return [{ name: nameMatch[1], input: {}, malformed: true }];
    return [{ name: 'malformed_tool_call', input: {}, malformed: true }];
}

export function parseToolCallsFromText(text) {
    if (!text) return [];
    const results = [];
    const seen = new Set();
    for (const re of TOOL_BLOCK_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const rawBlock = m[1].trim();
            // Фенсовый паттерн (незакрытый фенс) может захватить блок, целиком
            // обёрнутый в <tool_call>-теги, и деградировать до {input:{}} —
            // оставляем его hermes-паттерну.
            if (re !== TOOL_BLOCK_PATTERNS[0] || !/^<tool_call>[\s\S]*<\/tool_call>$/.test(rawBlock)) {
                for (const tc of parseToolCallBlock(rawBlock)) {
                    const key = `${tc.name}|${JSON.stringify(tc.input)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    results.push(tc);
                }
            }
        }
    }
    return results;
}

export function stripToolCallsFromText(text) {
    return text
        .replace(/```tool_call[\s\S]*?```/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .trim();
}

// Точка обрыва генерации после завершённого tool_call: без неё текстовый
// протокол даёт модели продолжить писать, и она выдумывает результат инструмента
// до его реального выполнения. Возвращает индекс конца последнего ЗАКРЫТОГО
// блока или -1, если резать рано (хвост пустой, или это начало следующего вызова,
// или недописанный маркер).
const CLOSED_TC_RE = /```tool_call\s*[\s\S]*?```|<tool_call>\s*[\s\S]*?<\/tool_call>/gi;
const TC_MARKERS = ['```tool_call', '<tool_call>'];

export function findToolCallCut(text) {
    if (!text) return -1;
    CLOSED_TC_RE.lastIndex = 0;
    let m, lastEnd = -1;
    while ((m = CLOSED_TC_RE.exec(text)) !== null) lastEnd = m.index + m[0].length;
    if (lastEnd === -1) return -1;
    const tail = text.slice(lastEnd);
    const t = tail.trimStart();
    if (!t) return -1;
    if (TC_MARKERS.some(mk => t.startsWith(mk))) return -1; // следующий вызов уже пишется
    if (t.length <= Math.max(...TC_MARKERS.map(mk => mk.length))
        && TC_MARKERS.some(mk => mk.startsWith(t))) return -1; // недописанный маркер
    return lastEnd;
}

// Незакрытый ```tool_call-фенс с распознанным вызовом: обрезаем хвостовые
// строки тела (последняя строка обычно — fabricated «результат», дописанный
// до закрытия фенса) и добавляем закрывающие ```. Без этого cut не работает
// (режет только ЗАКРЫТЫЕ блоки), а display-регэксп незакрытого фенса глотает
// весь продолжающийся ответ. Возвращает null, если вызвать распознать не
// удалось — тогда текст не трогаем. <tool_call>-теги без закрытия не
// обрабатываем: надёжного признака конца вызова в них нет.
export function closeUnclosedToolCallFence(text) {
    if (!text) return null;
    const markerIdx = text.lastIndexOf('```tool_call');
    if (markerIdx === -1) return null;
    const bodyStart = markerIdx + '```tool_call'.length;
    const body = text.slice(bodyStart);
    if (body.includes('```')) return null;
    const bodyLines = body.replace(/\n+$/, '').split('\n');
    for (;;) {
        const candidate = bodyLines.join('\n');
        if (parseToolCallBlock(candidate).some(c => !c.malformed)) {
            return text.slice(0, bodyStart) + candidate + '\n```';
        }
        if (bodyLines.length <= 1) return null;
        bodyLines.pop();
    }
}

// Нативный function calling:choices[0].message.tool_calls из нестримингового
// ответа → нормализованные вызовы для executeTool.
export function extractProviderToolCalls(value) {
    const raw = value?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const calls = [];
    for (const tc of raw) {
        if (!tc?.function?.name) continue;
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
        calls.push({ callId: tc.id || `call_${calls.length}`, name: tc.function.name, input });
    }
    return calls.length ? { calls, raw } : null;
}
