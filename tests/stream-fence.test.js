// Стрим длинного code-fence: регрессионные тесты на «переворот» фенсов.
// Раньше хвост длиннее MAX_PENDING_HOLD коммитился посередине фенса, сырой ```
// попадал в DOM, а закрывающий маркер начинал НОВЫЙ фенс — весь остаток
// сообщения уезжал в код.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/index.js', () => ({
    ST_WorldInfo: null,
    ST_Utils: null,
    extVersion: 'test',
    __extPath: 'third-party/ST-Copilot',
    refreshSessionDropdown: () => {},
}));

const { createStreamRenderer } = await import('../src/ui/render/stream-renderer.js');
const { renderMarkdown } = await import('../src/ui/ui-chat.js');

async function streamInChunks(renderer, full, chunkSize = 100) {
    for (let i = 0; i < full.length; i += chunkSize) {
        renderer.push(full.slice(0, i + chunkSize));
        await new Promise(r => setTimeout(r, 0));
    }
    renderer.flush();
}

describe('renderMarkdown: незакрытый фенс в хвосте', () => {
    it('рендерится как код-блок, а не сырой маркер', () => {
        const html = renderMarkdown('Текст\n\n```js\nconst a = 1;');
        expect(html).toContain('<pre class="scp-code-block lang-js">');
        expect(html).toContain('const a = 1;');
        expect(html).not.toContain('```');
    });

    it('незакрытый html-фенс НЕ исполняется — уходит в обычный код-блок', () => {
        const html = renderMarkdown('```html\n<script>alert(1)</scr' + 'ipt>');
        expect(html).not.toContain('scp-html-block-ph');
        expect(html).toContain('scp-code-block-wrap');
    });
});

describe('stream renderer: длинные фенсы', () => {
    it('фенс длиннее MAX_PENDING_HOLD: ни одного сырого ``` в DOM, один pre с полным кодом', async () => {
        const el = document.createElement('div');
        const r = createStreamRenderer({ el, preprocessed: true });
        const code = 'const x = 1;\n'.repeat(100); // ~1300 символов > 800
        const full = 'Вот код:\n\n```javascript\n' + code + '```\n\nГотово.';
        await streamInChunks(r, full);

        expect(el.textContent).not.toContain('```');
        const pres = el.querySelectorAll('pre.scp-code-block');
        expect(pres.length).toBe(1);
        expect(pres[0].textContent).toContain('const x = 1;');
        // код не потерян и не удвоен
        expect(pres[0].textContent.match(/const x = 1;/g).length).toBe(100);
        expect(el.textContent).toContain('Готово.');
    });

    it('фенс длиннее MAX_FENCE_HOLD: экстренный коммит, продолжение пишется в тот же pre', async () => {
        const el = document.createElement('div');
        const r = createStreamRenderer({ el, preprocessed: true });
        const code1 = 'line_a\n'.repeat(2000); // 14000 > 12000
        const code2 = 'const end = true;\n'.repeat(50);
        const full = '```javascript\n' + code1 + code2 + '```\n\nПосле.';
        await streamInChunks(r, full, 500);

        expect(el.textContent).not.toContain('```');
        const pres = el.querySelectorAll('pre.scp-code-block');
        expect(pres.length).toBe(1);
        expect(pres[0].textContent).toContain('const end = true;');
        expect(pres[0].textContent.match(/const x/g)?.length ?? 0).toBe(0); // нет чужого
        expect(el.textContent).toContain('После.');
    });

    it('стрим, оборванный внутри фенса (Stop): flush дорисовывает код, а не сырой маркер', async () => {
        const el = document.createElement('div');
        const r = createStreamRenderer({ el, preprocessed: true });
        const partial = 'Ответ:\n\n```html\n<div>не закончено';
        await streamInChunks(r, partial, 50);
        // без flush финального закрытия — как при Stop
        expect(el.textContent).not.toContain('```');
        expect(el.querySelectorAll('pre').length).toBe(1);
        expect(el.textContent).toContain('не закончено');
    });
});
