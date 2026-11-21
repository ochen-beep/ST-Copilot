// Блоки кода: обёртка с тулбаром и делегированное копирование.
//
// Проверяем два независимых слоя:
//  1. renderMarkdown выдаёт обёртку + тулбар + кнопку как чистый HTML
//     (иначе кнопка не выживала бы при innerHTML на каждом чанке стрима);
//  2. делегированный обработчик на #scp-messages находит код и копирует его,
//     в том числе после полной перерисовки контейнера.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ui-chat тянет index.js через util-debug и feature-lorebook-engine
// (циклическая зависимость), а index.js на загрузке модуля планирует init(),
// которому нужен полноценный контекст SillyTavern. Мокаем точку входа целиком —
// тот же приём, что в launcher-smoke.test.js.
vi.mock('../src/index.js', () => ({
    ST_WorldInfo: null,
    ST_Utils: null,
    extVersion: 'test',
    __extPath: 'third-party/ST-Copilot',
    refreshSessionDropdown: () => {},
}));

const { renderMarkdown, setupCodeBlockActions } = await import('../src/ui/ui-chat.js');


const SAMPLE = 'Обычный текст\n\n```javascript\nconst a = 1 && 2 < 3;\nconsole.log(`x`);\n```\n\nПосле блока.';

describe('renderMarkdown: обёртка блока кода', () => {
    it('создаёт обёртку, тулбар и кнопку копирования', () => {
        const html = renderMarkdown(SAMPLE);
        expect(html).toContain('<div class="scp-code-block-wrap lang-javascript">');
        expect(html).toContain('<div class="scp-code-toolbar">');
        expect(html).toContain('class="scp-code-copy-btn"');
        expect(html).toContain('<span>Копировать</span>');
    });

    it('показывает язык в тулбаре и сохраняет его класс на <pre>', () => {
        const html = renderMarkdown('```python\nprint(1)\n```');
        expect(html).toContain('<span class="scp-code-lang">python</span>');
        expect(html).toContain('<pre class="scp-code-block lang-python">');
    });

    it('для блока без языка ставит нейтральную подпись и не навешивает lang-класс', () => {
        const html = renderMarkdown('```\nplain\n```');
        expect(html).toContain('<div class="scp-code-block-wrap">');
        expect(html).not.toContain('lang-');
        expect(html).toContain('<span class="scp-code-lang">код</span>');
    });

    it('экранирует содержимое кода', () => {
        const html = renderMarkdown('```js\na && b < c > d\n```');
        expect(html).toContain('a &amp;&amp; b &lt; c &gt; d');
    });

    it('не ломает html-ветку: та идёт через реестр, а не через обёртку', () => {
        const html = renderMarkdown('```html\n<b>hi</b>\n```');
        expect(html).toContain('scp-html-block-ph');
        expect(html).not.toContain('scp-code-block-wrap');
    });

    it('не трогает inline-код', () => {
        const html = renderMarkdown('Значение `x` в тексте.');
        expect(html).toContain('<code class="scp-inline-code">x</code>');
        expect(html).not.toContain('scp-code-block-wrap');
    });
});

describe('setupCodeBlockActions: делегированное копирование', () => {
    let container;
    let writeText;
    let origClipboard;
    let origIsSecure;

    beforeEach(() => {
        document.body.innerHTML = '<div id="scp-messages"></div>';
        container = document.getElementById('scp-messages');

        writeText = vi.fn(() => Promise.resolve());
        origClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
        origIsSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

        setupCodeBlockActions();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (origClipboard) Object.defineProperty(Navigator.prototype, 'clipboard', origClipboard);
        if (origIsSecure) Object.defineProperty(window, 'isSecureContext', origIsSecure);
        document.body.innerHTML = '';
    });

    const clickCopy = () => {
        const btn = container.querySelector('.scp-code-copy-btn');
        // Кликаем по вложенному <span>, а не по самой кнопке — так проверяется closest().
        btn.querySelector('span').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return btn;
    };

    it('копирует раскодированный текст блока', () => {
        container.innerHTML = renderMarkdown(SAMPLE);
        clickCopy();
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith('const a = 1 && 2 < 3;\nconsole.log(`x`);');
    });

    it('даёт визуальный отклик на кнопке', () => {
        container.innerHTML = renderMarkdown(SAMPLE);
        const btn = clickCopy();
        expect(btn.classList.contains('copied')).toBe(true);
        expect(btn.querySelector('span').textContent).toBe('Скопировано');
    });

    it('переживает полную перерисовку контейнера (стрим/свайп)', () => {
        container.innerHTML = renderMarkdown(SAMPLE);
        clickCopy();
        expect(writeText).toHaveBeenCalledTimes(1);

        // Имитация innerHTML = renderMarkdown(...) на следующем чанке.
        container.innerHTML = renderMarkdown(SAMPLE + '\n\n```js\nsecond();\n```');
        const btns = container.querySelectorAll('.scp-code-copy-btn');
        expect(btns.length).toBe(2);

        btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(writeText).toHaveBeenCalledTimes(2);
        expect(writeText).toHaveBeenLastCalledWith('second();');
    });

    it('копирует нужный блок, когда их несколько', () => {
        container.innerHTML = renderMarkdown('```js\nfirst();\n```\n\n```css\nbody { color: red; }\n```');
        const btns = container.querySelectorAll('.scp-code-copy-btn');
        btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(writeText).toHaveBeenCalledWith('body { color: red; }');
    });

    it('не привязывает обработчик дважды', () => {
        setupCodeBlockActions();
        setupCodeBlockActions();
        container.innerHTML = renderMarkdown(SAMPLE);
        clickCopy();
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('игнорирует клики мимо кнопки', () => {
        container.innerHTML = renderMarkdown(SAMPLE);
        container.querySelector('.scp-code-block').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(writeText).not.toHaveBeenCalled();
    });

    it('не падает, если обёртка есть, а <code> отсутствует', () => {
        container.innerHTML = '<div class="scp-code-block-wrap"><div class="scp-code-toolbar">'
            + '<button class="scp-code-copy-btn"><span>Копировать</span></button></div></div>';
        expect(() => clickCopy()).not.toThrow();
        expect(writeText).not.toHaveBeenCalled();
    });
});

describe('renderMarkdown: языки фенсов с дефисом', () => {
    it('сохраняет полный тег lorebook-changes и не утекает в контент', () => {
        const html = renderMarkdown('```lorebook-changes\n{"changes":[1]}\n```');
        expect(html).toContain('lang-lorebook-changes');
        expect(html).toContain('{"changes":[1]}');
        expect(html).not.toContain('>-changes');
    });

    it('полный тег и в незакрытом фенсе', () => {
        const html = renderMarkdown('текст\n```memory-update\n{"k":1}');
        expect(html).toContain('lang-memory-update');
        expect(html).toContain('{"k":1}');
        expect(html).not.toContain('>-update');
    });
});
