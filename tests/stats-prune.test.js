// Бакеты статистики — day-ключи в вечных настройках: без подрезки растут
// бесконечно и ре-стрингифицируются в каждой сигнатуре/сейве.
import { describe, it, expect, beforeEach } from 'vitest';

import { recordStat } from '../src/features/feature-stats.js';

const EXT_KEY = 'st_copilot';
const settings = () => SillyTavern.getContext().extensionSettings[EXT_KEY];

function dateKey(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
    const ctx = SillyTavern.getContext();
    ctx.extensionSettings[EXT_KEY] = {};
    ctx.characterId = 5;
    ctx.characters = [];
    ctx.characters[5] = { avatar: 'a.png', name: 'A' };
    ctx.chat = [];
});

describe('подрезка бакетов статистики', () => {
    it('древние day-ключи удаляются, свежие и сегодняшние остаются', () => {
        const g = {};
        for (let i = 1; i <= 200; i++) g[dateKey(i)] = [0, 0, 0, 0, 0, 0, 0, i];
        settings().stats = { g, c: {}, ch: {} };

        recordStat(0, 1); // сегодня

        const after = settings().stats.g;
        expect(Object.keys(after).length).toBeLessThanOrEqual(121); // 120 + сегодняшний
        expect(after[dateKey(200)]).toBeUndefined(); // самый старый удалён
        expect(after[dateKey(1)]).toBeDefined();     // свежий остался
        expect(after[dateKey(0)][0]).toBe(1);        // сегодняшняя запись учтена
    });

    it('до порога срабатывания подрезка не трогает ничего', () => {
        const g = {};
        for (let i = 1; i <= 100; i++) g[dateKey(i)] = [0, 0, 0, 0, 0, 0, 0, 1];
        settings().stats = { g, c: {}, ch: {} };

        recordStat(0, 1);
        expect(Object.keys(settings().stats.g).length).toBe(101);
    });
});

// Бакеты статистики ключуются на стабильный avatar (не индекс ростера).
describe('ключ статистики персонажа', () => {
    it('recordStat пишет в бакет по avatar', () => {
        recordStat(0, 2);
        const st = settings().stats;
        expect(st.c['a.png']).toBeDefined();
        expect(Object.keys(st.c)).not.toContain('5');
    });
});
