import { describe, it, expect } from 'vitest';
import { parseToolCallsFromText, stripToolCallsFromText, extractProviderToolCalls, findToolCallCut } from '../src/utils/util-tool-parse.js';

describe('parseToolCallsFromText — протокол ```tool_call', () => {
    it('парсит одиночный вызов', () => {
        const text = 'Подумаю.\n```tool_call\n{"name": "search_chat", "input": {"queries": ["elf"]}}\n```\nГотово.';
        expect(parseToolCallsFromText(text)).toEqual([
            { name: 'search_chat', input: { queries: ['elf'] } },
        ]);
    });

    it('парсит массив вызовов в одном фенсе', () => {
        const text = '```tool_call\n[{"name": "a", "input": {}}, {"name": "b", "input": {"x": 1}}]\n```';
        expect(parseToolCallsFromText(text)).toEqual([
            { name: 'a', input: {} },
            { name: 'b', input: { x: 1 } },
        ]);
    });
});

describe('parseToolCallsFromText — протокол <tool_call> (Hermes)', () => {
    it('парсит одиночный вызов с arguments вместо input', () => {
        const text = '<tool_call>\n{"name": "search_web", "arguments": {"query": "lore"}}\n</tool_call>';
        expect(parseToolCallsFromText(text)).toEqual([
            { name: 'search_web', input: { query: 'lore' } },
        ]);
    });

    it('парсит несколько тегов и соседствует с прозой', () => {
        const text = 'Ищу. <tool_call>{"name": "a", "arguments": {"q": 1}}</tool_call> ещё <tool_call>{"name": "b", "input": {}}</tool_call>';
        expect(parseToolCallsFromText(text)).toEqual([
            { name: 'a', input: { q: 1 } },
            { name: 'b', input: {} },
        ]);
    });
});

describe('parseToolCallsFromText — устойчивость', () => {
    it('дедуплицирует точные дубли (перекрытие паттернов на незакрытом фенсе)', () => {
        const text = '```tool_call\n<tool_call>{"name": "a", "input": {"k": 1}}</tool_call>';
        const calls = parseToolCallsFromText(text);
        expect(calls.filter(c => c.name === 'a')).toHaveLength(1);
    });

    it('разные вызовы с одинаковым именем, но разным input не склеивает', () => {
        const text = '<tool_call>{"name": "a", "input": {"k": 1}}</tool_call><tool_call>{"name": "a", "input": {"k": 2}}</tool_call>';
        expect(parseToolCallsFromText(text)).toHaveLength(2);
    });

    it('тащит name из битого JSON', () => {
        const text = '```tool_call\n{"name": "get_chat_stats", "input": {oops\n```';
        expect(parseToolCallsFromText(text)).toEqual([
            { name: 'get_chat_stats', input: {} },
        ]);
    });
});

describe('stripToolCallsFromText', () => {
    it('убирает оба протокола', () => {
        const text = 'до ```tool_call\n{"name": "a", "input": {}}\n``` середина <tool_call>{"name": "b"}</tool_call> после';
        expect(stripToolCallsFromText(text)).toBe('до  середина  после');
    });
});

describe('extractProviderToolCalls — native function calling', () => {
    it('извлекает calls из choices[0].message.tool_calls', () => {
        const value = {
            choices: [{
                message: {
                    content: null,
                    tool_calls: [{
                        id: 'call_abc',
                        type: 'function',
                        function: { name: 'search_chat', arguments: '{"queries":["x"]}' },
                    }],
                },
            }],
        };
        const prov = extractProviderToolCalls(value);
        expect(prov.calls).toEqual([{ callId: 'call_abc', name: 'search_chat', input: { queries: ['x'] } }]);
        expect(prov.raw).toHaveLength(1);
    });

    it('битый arguments → пустой input, а не падение', () => {
        const value = { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{oops' } }] } }] };
        expect(extractProviderToolCalls(value).calls).toEqual([{ callId: 'c1', name: 'a', input: {} }]);
    });

    it('null без tool_calls', () => {
        expect(extractProviderToolCalls({ choices: [{ message: { content: 'hi' } }] })).toBeNull();
        expect(extractProviderToolCalls(null)).toBeNull();
    });
});

describe('findToolCallCut — точка обрыва после tool_call', () => {
    it('нет tool_call — нет обрыва', () => {
        expect(findToolCallCut('Просто текст без вызовов.')).toBe(-1);
        expect(findToolCallCut('')).toBe(-1);
    });

    it('незакрытый фенс — ждём', () => {
        expect(findToolCallCut('Смотрю:\n```tool_call\n{"name": "a"')).toBe(-1);
    });

    it('закрытый фенс с пустым хвостом — ждём (модель может писать следующий вызов)', () => {
        expect(findToolCallCut('```tool_call\n{"name":"a"}\n```')).toBe(-1);
        expect(findToolCallCut('```tool_call\n{"name":"a"}\n```\n  ')).toBe(-1);
    });

    it('хвост = начало следующего tool_call — ждём', () => {
        expect(findToolCallCut('```tool_call\n{"name":"a"}\n```\n```tool_call\n{"name":"b"')).toBe(-1);
        expect(findToolCallCut('```tool_call\n{"name":"a"}\n```\n```to')).toBe(-1);
        expect(findToolCallCut('```tool_call\n{"name":"a"}\n```\n<tool_call>')).toBe(-1);
    });

    it('проза после закрытого блока — обрыв в конце блока', () => {
        const text = 'Посмотрю.\n```tool_call\n{"name":"a"}\n```\nРезультат поиска: эльф найден...';
        const cut = findToolCallCut(text);
        expect(cut).toBe(text.indexOf('```', '```tool_call\n{"name":"a"}\n'.length - 3) + 3);
        expect(text.slice(0, cut).endsWith('```')).toBe(true);
    });

    it('проза ДО блока сохраняется, выдуманный результат после — отрезается', () => {
        const text = 'Сейчас проверю лорбук. <tool_call>{"name":"x"}</tool_call> Запись существует, значит...';
        const cut = findToolCallCut(text);
        expect(text.slice(0, cut)).toBe('Сейчас проверю лорбук. <tool_call>{"name":"x"}</tool_call>');
    });

    it('несколько закрытых блоков подряд — обрыв после последнего', () => {
        const text = '```tool_call\n{"name":"a"}\n```\n```tool_call\n{"name":"b"}\n```\nТеперь отвечу.';
        const cut = findToolCallCut(text);
        expect(text.slice(0, cut).endsWith('```')).toBe(true);
        expect(text.slice(cut)).toBe('\nТеперь отвечу.');
    });
});

// extractToolCallPlaceholders
// (плоский ре-парсинг в _renderMsgBodyContent использует тот же парсер —
// расхождение числа слотов сдвигает карточки).
import { extractToolCallPlaceholders } from '../src/ui/render-msg.js';

describe('extractToolCallPlaceholders — слоты по факту парсинга', () => {
    it('слоты равны числу вызовов плоского ре-парсинга (включая мусорные фенсы)', () => {
        const text = '```tool_call' + '\n{"name": "search_chat", "input": {}}\n```\n' + '```tool_call' + '\nмусор без json\n```\n' + '```tool_call' + '\n{"name": "get_chat_stats", "input": {}}\n```';
        const { nextIndex } = extractToolCallPlaceholders(text, 0);
        expect(nextIndex).toBe(parseToolCallsFromText(text).length);
    });

    it('валидные фенсы нумеруются подряд', () => {
        const text = 'a\n' + '```tool_call' + '\n{"name": "search_chat", "input": {}}\n```\n' + 'b\n' + '```tool_call' + '\n{"name": "search_chat", "input": {}}\n```';
        const { text: out, nextIndex } = extractToolCallPlaceholders(text, 5);
        expect(nextIndex).toBe(7);
        expect(out.match(/\x00TC_\d+\x00/g)).toHaveLength(2);
    });
});
