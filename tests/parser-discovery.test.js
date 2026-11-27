import { describe, it, expect } from 'vitest';
import { discoverProposalBlocks } from '../src/utils/util-block-discovery.js';

const EMPTY = { lb: false, char: false, charCreate: false, chat: false, preset: false };

describe('discoverProposalBlocks', () => {
    it('returns all-false for empty text', () => {
        expect(discoverProposalBlocks('')).toEqual(EMPTY);
    });

    it('returns all-false for plain prose without any ``` fence', () => {
        const text = 'Hello world. This is a response with no markdown code fences at all.\nNew paragraph.';
        expect(discoverProposalBlocks(text)).toEqual(EMPTY);
    });

    it('returns all-false for unrelated code fence (e.g. javascript)', () => {
        const text = '```javascript\nconst x = 1;\n```';
        expect(discoverProposalBlocks(text)).toEqual(EMPTY);
    });

    it('detects lorebook-changes only', () => {
        const text = 'Here is my plan:\n```lorebook-changes\n[]\n```';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, lb: true });
    });

    it('detects character-changes only', () => {
        const text = '```character-changes\n[]\n```';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, char: true });
    });

    it('detects character-create only', () => {
        const text = '```character-create\n{}\n```';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, charCreate: true });
    });

    it('detects chat-changes only', () => {
        const text = '```chat-changes\n[]\n```';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, chat: true });
    });

    it('detects all four blocks together', () => {
        const text = [
            '```lorebook-changes\n[]\n```',
            '```character-changes\n[]\n```',
            '```character-create\n{}\n```',
            '```chat-changes\n[]\n```',
            'Plain text between blocks. ```javascript\nconst x = 1;\n```',
        ].join('\n\n');
        expect(discoverProposalBlocks(text)).toEqual({ lb: true, char: true, charCreate: true, chat: true, preset: false });
    });

    it('detects open (unclosed) block — no trailing ```', () => {
        // Имитация стрима, который прервался: блок начат, но ``` не пришло.
        const text = 'Some preamble\n```character-changes\n[ { "key": "foo", ...';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, char: true });
    });

    it('detects block even when only opening fence with no newline content yet', () => {
        const text = 'Text ```lorebook-changes';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, lb: true });
    });

    it('detects multiple occurrences of same block (idempotent flag)', () => {
        const text = '```character-changes\n[]\n```\n...\n```character-changes\n[]\n```';
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, char: true });
    });

    it('handles null/undefined input safely', () => {
        expect(discoverProposalBlocks(null)).toEqual(EMPTY);
        expect(discoverProposalBlocks(undefined)).toEqual(EMPTY);
        expect(discoverProposalBlocks(123)).toEqual(EMPTY);
    });

    it('handles langid with case sensitivity (matches langid as-is)', () => {
        // Парсеры используют case-sensitive regex (буквы в нижнем регистре для LANGID),
        // так что discovery тоже case-sensitive — сохраняем согласованность.
        const text = '```LOREBOOK-CHANGES\n[]\n```';
        expect(discoverProposalBlocks(text)).toEqual(EMPTY);
    });

    it('does not choke on malformed fence (backticks only)', () => {
        const text = 'Some text\n```\nplain code\n```\nmore text';
        expect(discoverProposalBlocks(text)).toEqual(EMPTY);
    });

    it('handles very long string containing a block mid-stream', () => {
        const padding = 'lorem ipsum '.repeat(2000);
        // Используем обычную конкатенацию, а не template literal: обратные кавычки
        // внутри ``` ``` fence нельзя вкладывать в `${}`-литерал — они преждевременно
        // закрывают template.
        const text = padding + '\n```chat-changes\n[]\n```\n' + padding;
        expect(discoverProposalBlocks(text)).toEqual({ ...EMPTY, chat: true });
    });
});