// Фаззинг структурных парсеров модельного вывода. Контракт: на ЛЮБОМ входе
// парсер не бросает — деградирует в null/[]/«нет proposals» (модель может
// вернуть что угодно). Вдохновлено ревью: regex+JSON — самая хрупкая часть.
import { describe, it, expect } from 'vitest';

import { parseMemoryBlockFromText } from '../src/features/feature-memory.js';
import { parseToolCallsFromText, extractProviderToolCalls, findToolCallCut } from '../src/utils/util-tool-parse.js';
import { parseChatChangesFromText } from '../src/features/feature-chatedit-engine.js';
import { parseLBChangesFromText } from '../src/features/feature-lorebook-engine.js';
import { parseCharChangesFromText, parseCharCreationFromText } from '../src/features/feature-character-engine.js';
import { extractToolCallPlaceholders } from '../src/ui/render-msg.js';

// Детерминированный ГПСЧ — воспроизводимость прогона.
function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const BASES = [
    '```memory-update\n[{"action":"add","scope":"character","key":"Style","value":"Пиши кратко"}]\n```',
    '```tool_call\n{"name": "search_chat", "input": {"queries": ["elf", "dragon"]}}\n```',
    '```chat-changes\n{"changes":[{"action":"delete","msg_index":1},{"action":"overwrite","msg_index":2,"content":"x"}]}\n```',
    '```lorebook-changes\n{"changes":[{"action":"edit","book":"World","name":"Elf Gate","content":"Стража"}]}\n```',
    '```character-changes\n{"changes":[{"field":"description","action":"overwrite","value":"Новая карта"}]}\n```',
    '```character-create\n{"name":"Hero","description":"Тест"}\n```',
    'text before\n```tool_call\n{"name": "get_chat_stats", "input": {}}\n```\ntext after',
];

const CHARS = '{}[]",:\\`\'\n\t<>/()$&;= ♪€漢😀';
function mutate(str, rnd) {
    let s = str;
    const ops = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < ops; i++) {
        const op = Math.floor(rnd() * 7);
        const pos = Math.floor(rnd() * (s.length + 1));
        if (op === 0) s = s.slice(0, pos);                                  // обрыв
        else if (op === 1) s = s.slice(0, pos) + CHARS[Math.floor(rnd() * CHARS.length)] + s.slice(pos);
        else if (op === 2) s = s.replace(/"/, "'");
        else if (op === 3 && s.length > 1) s = s.slice(0, pos) + s.slice(pos + 1);
        else if (op === 4) s = s.slice(0, pos) + s.slice(0, pos);           // дублирование хвоста
        else if (op === 5) s = s.replace('\n', '\r\n');
        else if (op === 6) s = '```tool_call\n' + s;                        // вложение чужого фенса
    }
    return s;
}

const PARSERS = [
    ['parseMemoryBlockFromText', parseMemoryBlockFromText],
    ['parseToolCallsFromText', parseToolCallsFromText],
    ['parseChatChangesFromText', parseChatChangesFromText],
    ['parseLBChangesFromText', parseLBChangesFromText],
    ['parseCharChangesFromText', parseCharChangesFromText],
    ['parseCharCreationFromText', parseCharCreationFromText],
];

describe('фаззинг парсеров: никаких исключений на произвольном входе', () => {
    it('500 мутированных блоков — ни один парсер не бросает', () => {
        const rnd = lcg(20261028);
        const failures = [];
        for (let i = 0; i < 500; i++) {
            const input = mutate(BASES[Math.floor(rnd() * BASES.length)], rnd);
            for (const [name, fn] of PARSERS) {
                try {
                    fn(input);
                } catch (e) {
                    failures.push(`#${i} ${name} бросил на ${JSON.stringify(input.slice(0, 80))}: ${e.message}`);
                }
            }
            // вспомогательные тул-парсеры тоже в контракте
            try {
                extractProviderToolCalls(input);
                findToolCallCut(input);
            } catch (e) {
                failures.push(`#${i} tool-utils бросили: ${e.message}`);
            }
        }
        expect(failures).toEqual([]);
    });

    it('инвариант слотов: extractToolCallPlaceholders == числу вызовов плоского парсинга', () => {
        const rnd = lcg(777);
        for (let i = 0; i < 200; i++) {
            const input = mutate(BASES[Math.floor(rnd() * BASES.length)], rnd);
            const { nextIndex } = extractToolCallPlaceholders(input, 0);
            expect(nextIndex).toBe(parseToolCallsFromText(input).length);
        }
    });

    it('валидные блоки по-прежнему парсятся (фаззинг не сломал happy path)', () => {
        expect(parseMemoryBlockFromText(BASES[0])).toEqual([
            { action: 'add', scope: 'character', key: 'Style', value: 'Пиши кратко' },
        ]);
        expect(parseToolCallsFromText(BASES[1])[0].name).toBe('search_chat');
        expect(parseChatChangesFromText(BASES[2])).toHaveLength(2);
    });
});
