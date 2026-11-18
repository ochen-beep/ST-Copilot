// Tool cards the user reads: search results render as a link list, page reads
// as link + preview; raw JSON stays available in a collapsed details block.
import { describe, it, expect, beforeEach } from 'vitest';

let ui;

const ctx = SillyTavern.getContext();

beforeEach(async () => {
    document.body.innerHTML = '';
    ctx.extensionSettings['st_copilot'] = { toolsEnabled: true };
    ui = await import('../src/features/feature-tools-ui.js');
});

describe('human-readable tool card results', () => {
    it('search_web result renders as clickable link list with snippets', () => {
        const el = ui.createToolCallEl({
            id: 't1', name: 'search_web', status: 'done',
            input: { query: 'q' },
            result: { provider: 'serper', query: 'q', results: [
                { title: 'Everest <wiki>', url: 'https://en.wikipedia.org/wiki/Everest', snippet: '8848 m <high>' },
                { title: 'No Link Result', url: '', snippet: '' },
            ], note: 'served by serper' },
        });
        const links = [...el.querySelectorAll('.scp-tool-hr a')];
        expect(links).toHaveLength(1);
        expect(links[0].href).toBe('https://en.wikipedia.org/wiki/Everest');
        expect(links[0].target).toBe('_blank');
        expect(links[0].rel).toContain('noopener');
        // escaping: angle brackets must not become real tags
        expect(links[0].textContent).toContain('<wiki>');
        expect(el.querySelectorAll('.scp-tool-hr li')).toHaveLength(2);
        expect(el.querySelector('.scp-tool-hr-note')?.textContent).toBe('served by serper');
        // raw JSON preserved in collapsed details
        expect(el.querySelector('.scp-tool-raw details, details.scp-tool-raw')).toBeTruthy();
        expect(el.querySelector('.scp-tool-raw pre').textContent).toContain('"provider": "serper"');
        // the JSON must be escaped, not live markup
        expect(el.querySelector('.scp-tool-raw pre').querySelector('script')).toBeNull();
    });

    it('tavily answer is displayed above the list', () => {
        const el = ui.createToolCallEl({
            id: 't2', name: 'search_web', status: 'done',
            input: { query: 'q' },
            result: { provider: 'tavily', query: 'q', answer: 'Direct answer', results: [{ title: 'T', url: 'https://t.com', snippet: 's' }] },
        });
        expect(el.querySelector('.scp-tool-hr-answer')?.textContent).toBe('Direct answer');
    });

    it('read_url result renders link + length + text preview', () => {
        const el = ui.createToolCallEl({
            id: 't3', name: 'read_url', status: 'done',
            input: { url: 'https://example.com' },
            result: { url: 'https://example.com', title: 'Example Page', total_length: 4200, text: 'x'.repeat(5000) },
        });
        const a = el.querySelector('.scp-tool-hr-link a');
        expect(a?.href).toBe('https://example.com/');
        expect(a?.textContent).toBe('Example Page');
        expect(el.querySelector('.scp-tool-hr-meta')?.textContent).toContain('4200');
        expect(el.querySelector('.scp-tool-hr-text')?.textContent?.length).toBeLessThanOrEqual(401);
    });

    it('error results and other tools keep the raw JSON view', () => {
        const el = ui.createToolCallEl({
            id: 't4', name: 'search_chat', status: 'error',
            input: { queries: ['x'] },
            result: { error: 'boom' },
        });
        expect(el.querySelector('.scp-tool-hr')).toBeNull();
        expect(el.querySelector('.scp-tool-call-result')?.textContent).toContain('boom');
        expect(el.querySelector('.scp-tool-call-result')?.className).toContain('error-result');
    });
});
