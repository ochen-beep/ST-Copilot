// Long tool chains fold behind one summary header ("Searched the web"
// pattern); live passes keep the group open while something runs or fails.
import { describe, it, expect, beforeEach } from 'vitest';

let ui;

const ctx = SillyTavern.getContext();

function makeCards(container, n, status = 'done') {
    for (let i = 0; i < n; i++) {
        const ph = document.createElement('div');
        ph.className = 'scp-tool-call-ph';
        ph.dataset.tcid = String(i);
        container.appendChild(ph);
    }
    return Array.from({ length: n }, (_, i) => ({
        id: `t${i}`,
        name: i % 2 === 0 ? 'search_web' : 'search_chat',
        input: { query: `q${i}` },
        status,
        result: { ok: true },
    }));
}

beforeEach(async () => {
    document.body.innerHTML = '';
    ctx.extensionSettings['st_copilot'] = { toolsEnabled: true, toolsCollapseChains: true, toolsCollapseThreshold: 3 };
    ui = await import('../src/features/feature-tools-ui.js');
});

describe('collapseToolChains via postProcessToolCalls', () => {
    it('folds a chain of 5 consecutive done cards into one collapsed group', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const calls = makeCards(container, 5);
        ui.postProcessToolCalls(container, calls);

        const group = container.querySelector('.scp-tc-group');
        expect(group).toBeTruthy();
        expect(group.querySelectorAll('.scp-inline-tool-call')).toHaveLength(5);
        expect(group.querySelector('.scp-tc-group-summary').textContent).toContain('5');
        expect(group.querySelector('.scp-tc-group-summary').textContent).toContain('web search ×3');
        expect(group.querySelector('.scp-tc-group-status').textContent).toBe('Готово');
        expect(group.classList.contains('open')).toBe(false);
    });

    it('keeps a live group open while a card is running', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const calls = makeCards(container, 4, 'running');
        ui.postProcessToolCalls(container, calls);

        const group = container.querySelector('.scp-tc-group');
        expect(group.classList.contains('open')).toBe(true);
        expect(group.querySelector('.scp-tc-group-status').textContent).toContain('Выполняется');
    });

    it('leaves short chains and collapsed setting off untouched', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        ui.postProcessToolCalls(container, makeCards(container, 2));
        expect(container.querySelector('.scp-tc-group')).toBeFalsy();

        ctx.extensionSettings['st_copilot'].toolsCollapseChains = false;
        const c2 = document.createElement('div');
        document.body.appendChild(c2);
        ui.postProcessToolCalls(c2, makeCards(c2, 6));
        expect(c2.querySelector('.scp-tc-group')).toBeFalsy();
    });

    it('is idempotent: a second pass refreshes without duplicating groups', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const calls = makeCards(container, 4);
        ui.postProcessToolCalls(container, calls);
        // Tool finished between passes: card status flips to done.
        calls.forEach(c => { c.status = 'done'; });
        ui.postProcessToolCalls(container, calls);

        expect(container.querySelectorAll('.scp-tc-group')).toHaveLength(1);
        expect(container.querySelector('.scp-tc-group-status').textContent).toBe('Готово');
        expect(container.querySelectorAll('.scp-inline-tool-call')).toHaveLength(4);
    });
});
