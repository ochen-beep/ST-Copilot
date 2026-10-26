// Чистый парсер текстовых tool-протоколов: без импортов и ST-зависимостей,
// чтобы тесты и любые потребители не тянули граф движков/точку входа.

// Два текстовых протокола: ```tool_call фенсы (наш формат) и <tool_call> теги
// (Hermes-формат — его спонтанно эмитят модели, затюненные на function calling).
const TOOL_BLOCK_PATTERNS = [
    /```tool_call\n?([\s\S]*?)(?:```|$)/gi,
    /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi,
];

function parseToolCallBlock(rawBlock) {
    if (!rawBlock) return [];

    let extracted = [];

    try {
        const parsed = JSON.parse(rawBlock);
        if (Array.isArray(parsed)) {
            extracted = parsed.filter(p => p && p.name).map(p => ({ name: p.name, input: p.input || p.arguments || {} }));
        } else if (parsed && parsed.name) {
            extracted.push({ name: parsed.name, input: parsed.input || parsed.arguments || {} });
        }
    } catch (_) {}

    if (!extracted.length) {
        try {
            const fixedRaw = '[' + rawBlock.replace(/}\s*{/g, '},{') + ']';
            const parsed = JSON.parse(fixedRaw);
            if (Array.isArray(parsed)) {
                extracted = parsed.filter(p => p && p.name).map(p => ({ name: p.name, input: p.input || p.arguments || {} }));
            }
        } catch (_) {}
    }

    if (!extracted.length) {
        const lines = rawBlock.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line.trim());
                if (parsed && parsed.name) {
                    extracted.push({ name: parsed.name, input: parsed.input || parsed.arguments || {} });
                }
            } catch (_) {}
        }
    }

    if (!extracted.length) {
        const nameMatch = rawBlock.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) {
            extracted.push({ name: nameMatch[1], input: {} });
        } else {
            extracted.push({ name: 'parsing...', input: {} });
        }
    }

    return extracted;
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
