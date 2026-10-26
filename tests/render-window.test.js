import { describe, it, expect } from 'vitest';
import { computeRenderFrom } from '../src/ui/render/render-window.js';

describe('computeRenderFrom — окно ленивого рендера сессии', () => {
    const W = 80;

    it('короткая сессия — рендер с нуля', () => {
        expect(computeRenderFrom(0, undefined, W)).toBe(0);
        expect(computeRenderFrom(50, undefined, W)).toBe(0);
    });

    it('длинная сессия без истории расширения — только хвост', () => {
        expect(computeRenderFrom(200, undefined, W)).toBe(120);
    });

    it('расширенное пользователем окно сохраняется при новых сообщениях', () => {
        const from = computeRenderFrom(200, undefined, W); // 120
        const expanded = from - W; // пользователь нажал «показать ещё»
        expect(computeRenderFrom(205, expanded, W)).toBe(expanded);
    });

    it('окно за границами (сессия изменилась снаружи) — сброс к хвосту', () => {
        expect(computeRenderFrom(50, 100, W)).toBe(0);
        expect(computeRenderFrom(200, -5, W)).toBe(120);
    });

    it('ровно на границе окна — рендер с нуля', () => {
        expect(computeRenderFrom(80, undefined, W)).toBe(0);
        expect(computeRenderFrom(81, undefined, W)).toBe(1);
    });
});
