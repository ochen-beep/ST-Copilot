import { describe, it, expect } from 'vitest';
import { parseToolCallsFromText, stripToolCallsFromText, extractProviderToolCalls } from '../src/utils/util-tool-parse.js';

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
