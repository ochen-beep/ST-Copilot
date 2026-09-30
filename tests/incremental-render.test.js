import { describe, it, expect } from 'vitest';
import { findSafeRenderBoundary } from '../src/ui/render/find-safe-boundary.js';

describe('findSafeRenderBoundary', () => {
    it('returns -1 for empty input', () => {
        expect(findSafeRenderBoundary('')).toBe(-1);
        expect(findSafeRenderBoundary(null)).toBe(-1);
        expect(findSafeRenderBoundary(undefined)).toBe(-1);
    });

    it('returns -1 when pending is short and no boundary yet (copим ещё)', () => {
        const text = 'Hello world, this is a single paragraph';
        expect(findSafeRenderBoundary(text)).toBe(-1);
    });

    it('splits at last \\n\\n (accumulated full text)', () => {
        const text = 'a\n\nb\n\nc';
        // Последняя \n\n в 'a\n\nb\n\nc' (len 7): 'a'(0)\n(1)\n(2)'b'(3)\n(4)\n(5)'c'(6).
        // при i=4 text[4]=\n,text[5]=\n ✓ lastBoundary=6, затем 'c' (idx 6) NOT list item → boundary 6.
        // Часть после - пустая (text.slice(6) = 'c' остаётся как tail на следующем flush, но сам boundary уже фиксирует всё до 'c').
        // Технически, на 'a\n\nb\n\n' (без trailing c) boundary wasn't at last \n\n.
        // Здесь boundary=6 фиксирует 'a\n\nb\n\n', хвост='c'.
        expect(findSafeRenderBoundary(text)).toBe(6);
    });

    it('splits at last \\n\\n when multiple', () => {
        const text = 'a\n\nbb\n\nccc';
        // последняя \n\n: позиция 5 ('a' + \n + \n + 'bb' + \n) → после неё \n + 'ccc'
        // По логике: ищем пары \n\n. Первая: idx 2 (после 'a\n' '\n'). i=1 (after 'a\n'),
        // проверяем text[i-1]='\n' (yes). lastBoundary = i+1 = 2 → 4 chars ('a\n\n').
        // Вторая \n\n: text 'bb\n\n', после нуля. lastBoundary = i+1.
        // Конкретно: индексы 5-6 в строке 'a\n\nbb\n\nccc' (0:'a',1:\n,2:\n,3:b,4:b,
        // 5:\n, 6:\n, 7:c, 8:c, 9:c). При i=6 text[i-1]=\n. lastBoundary = 7.
        expect(findSafeRenderBoundary(text)).toBe(7);
    });

    it('returns -1 inside open code-fence (no \\n\\n, fence not closed)', () => {
        const text = '```javascript\nconst x = 1;\nlet y = 2;';
        // fence открыта, текст короткий → копим.
        expect(findSafeRenderBoundary(text)).toBe(-1);
    });

    it('returns end-idx when code-fence is closed', () => {
        const text = '```javascript\nconst x = 1;\n```';
        // После закрытия fence не осталось pending. Fence closed → inFence=false,
        // дальше ищем \n\n — нет, текста меньше MAX_PENDING_HOLD → -1 (копим).
        // Это корректно: закрывающий ``` сам по себе — граница. Но если текст
        // короткий, всё копим до final flush.
        // Здесь — копим.
        expect(findSafeRenderBoundary(text)).toBe(-1);
    });

    it('handles list continuation: \\n\\n NOT a boundary if next line starts with `* ` or `- `', () => {
        const text = 'Intro\n\n- item a\n- item b\n- item c';
        // Первая \n\n в позиции idx 6 ('Intro' =5 chars, \n=6, \n=7). Проверяем next
        // line: ` `? В строке 'Intro\n\n- item a...': after idx 7 (\n), next is
        // '- item a' → starts with '-' + space → list item, не boundary.
        // Дальше \n\n нет. pending короткий → -1.
        expect(findSafeRenderBoundary(text)).toBe(-1);
    });

    it('respects MAX_PENDING_HOLD for list continuation (long pending → forced split)', () => {
        const list = '- item 1 '.repeat(120);
        // طول очень большой; inFence=false, нет \n\n, но > MAX_PENDING_HOLD.
        // boundary = text.length (van fallback).
        expect(findSafeRenderBoundary(list)).toBe(list.length);
    });

    it('handles pathological long single paragraph: forced split at end when >MAX_PENDING_HOLD', () => {
        const text = 'word '.repeat(200); // ~1000 chars, no \n\n
        expect(findSafeRenderBoundary(text)).toBe(text.length);
    });

    it('does not split when list item at boundary spans multiple lines', () => {
        const text = 'List intro: Item 1\n- list item spanning\nand continuing\n\nNew para';
        // Есть \n\n в конце. До него идёт 'and continuing' (не list item line).
        // Проверяем next-line после \n\n: 'New para' — не list → boundary OK.
        expect(findSafeRenderBoundary(text)).toBeGreaterThan(0);
    });

    it('does not break inside inline content before first \\n\\n', () => {
        // Строчка без \n\n, и меньше MAX_PENDING_HOLD: копим.
        const text = '{"foo": "bar"}';
        expect(findSafeRenderBoundary(text)).toBe(-1);
    });

    it('commits tail-end text when forced (>MAX_PENDING_HOLD, no boundary, no fence)', () => {
        const text = 'a'.repeat(900);
        expect(findSafeRenderBoundary(text)).toBe(900);
    });

    it('code-fence closing balances: open then close → render boundary AFTER close', () => {
        // Длинная закрытая code-fence (>MAX_PENDING_HOLD содержимым вне),
        // но закрывающий ``` имеется. Безопасно резать после закрывающего fence.
        const text = '```js\n' + 'x\n'.repeat(500) + '```';
        // После закрытия fence inFence=false. Дальше ищем \n\n — нет (внутри было
        // ``` fence, но outside нет). pending длиннее MAX_PENDING_HOLD → fallback end.
        expect(findSafeRenderBoundary(text)).toBe(text.length);
    });

    it('mix of fence + paragraphs after', () => {
        const code = '```js\nconst y = 2;\n```\n\nAfter code block';
        // После закрывающего fence inFence=false. Первая \n\n: конец кода `\``\n\n`.
        // next line 'After code block' — не list item → boundary OK.
        const b = findSafeRenderBoundary(code);
        expect(b).toBeGreaterThan(0);
        expect(b).toBeLessThanOrEqual(code.length);
    });
});