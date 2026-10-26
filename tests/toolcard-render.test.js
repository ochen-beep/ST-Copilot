// Рендер ответа с текстовым tool_call-фенсом + сохранёнными toolCalls:
// карточка должна заполниться, текст после фенса — отобразиться.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/index.js', () => ({
    ST_WorldInfo: null, ST_Utils: null, extVersion: 'test', __extPath: 'third-party/ST-Copilot',
    refreshSessionDropdown: () => {},
}));

const { _renderMsgBodyContent, extractToolCallPlaceholders } = await import('../src/ui/ui-chat.js');

function makeMsgEl() {
    const el = document.createElement('div');
    el.innerHTML = `<div class="scp-msg-body"><div class="scp-msg-content"></div></div>`;
    return el;
}

describe('_renderMsgBodyContent: ответ после tool-раунда (текстовый протокол)', () => {
    it('фенс в content + toolCalls → карточка заполнена, текст виден', () => {
        const msg = {
            id: 'm1', role: 'assistant', timestamp: Date.now(),
            content: '```tool_call\n{"name": "get_recent_messages", "input": {"count": 10}}\n```\n\n2',
            reasoning: 'Думаю о вызове инструмента…',
            toolCalls: [{ id: 'tc_1', name: 'get_recent_messages', input: { count: 10 }, status: 'done', result: '{"messages":[]}' }],
        };
        const el = makeMsgEl();
        _renderMsgBodyContent(el, msg);

        const card = el.querySelector('.scp-tool-call-item');
        const ph = el.querySelector('.scp-tool-call-ph');
        const text = el.querySelector('.scp-msg-content').textContent;
        expect(ph).toBeNull();                    // плейсхолдер заменён карточкой
        expect(card).not.toBeNull();
        expect(card.textContent).toContain('Get Recent Messages');
        expect(text).toContain('2');              // текст ответа не потерян
    });

    it('extractToolCallPlaceholders нумерует фенсы от startIndex', () => {
        const r = extractToolCallPlaceholders('a ```tool_call\n{"name":"x"}\n``` b', 3);
        expect(r.text).toContain('\x00TC_3\x00');
        expect(r.nextIndex).toBe(4);
    });
});

describe('_renderMsgBodyContent: порядок индексов при фенсе в reasoning', () => {
    it('фенс в reasoning НЕ уводит индекс у фенса контента', () => {
        // Модель написала вызов и в размышлениях, и в ответе; исполнен один —
        // он соответствует фенсу контента, а не первому по тексту.
        const msg = {
            id: 'm2', role: 'assistant', timestamp: Date.now(),
            content: '```tool_call\n{"name": "get_recent_messages", "input": {}}\n```\n\n42',
            reasoning: 'Сейчас вызову: ```tool_call\n{"name": "get_recent_messages", "input": {}}\n```',
            toolCalls: [{ id: 'tc_1', name: 'get_recent_messages', input: {}, status: 'done', result: '{"messages":[]}' }],
        };
        const el = makeMsgEl();
        _renderMsgBodyContent(el, msg);

        const content = el.querySelector('.scp-msg-content');
        expect(content.querySelector('.scp-tool-call-item')).not.toBeNull();
        expect(content.textContent).toContain('42');
        expect(content.querySelector('.scp-tool-call-ph')).toBeNull();
    });
});
