// Регрессия на реальный баг из багрепорта: лорбук в массивном (legacy/embedded)
// формате + удаление/добавление записи через копилот → `delete data.entries[uid]`
// на массиве оставлял дыру → JSON.stringify писал `null` → весь WI-пайплайн
// SillyTavern падал на следующей загрузке. Граница: _normalizeWIBook.
import { describe, it, expect, beforeEach } from 'vitest';

let engine;

beforeEach(async () => {
    engine = await import('../src/features/feature-lorebook-engine.js');
});

function arrayBook(n) {
    const entries = [];
    for (let i = 0; i < n; i++) entries.push({ id: i, content: `content-${i}`, keys: [`key-${i}`] });
    return { name: 'TestBook', entries };
}

describe('_normalizeWIBook — граница форматов лорбука', () => {
    it('массивный формат конвертируется в объект по uid, null-дыры исчезают', () => {
        const data = arrayBook(3);
        engine._normalizeWIBook(data);
        expect(Array.isArray(data.entries)).toBe(false);
        expect(Object.keys(data.entries)).toHaveLength(3);
        expect(data.entries[0].content).toBe('content-0');
        expect(data.entries[2].uid).toBe(2);
    });

    it('объектный формат не трогается', () => {
        const data = { entries: { 5: { uid: 5, content: 'x' } } };
        engine._normalizeWIBook(data);
        expect(data.entries[5].content).toBe('x');
    });

    it('массив с null-элементом (уже частично испорченный файл) не падает', () => {
        const data = { name: 'B', entries: [null, { id: 7, content: 'ok', keys: ['k'] }] };
        engine._normalizeWIBook(data);
        expect(Object.keys(data.entries)).toEqual(['7']);
        expect(JSON.stringify(data)).not.toContain('null');
    });

    it('полный цикл add+delete на массивной книге: после нормализации нет null', () => {
        const data = arrayBook(2);
        engine._normalizeWIBook(data);
        // путь из applyLBChanges: delete data.entries[uid] — на объекте это дыра не делает
        delete data.entries[0];
        const json = JSON.stringify(data);
        expect(json).not.toContain('"entries":[null');
        expect(json).not.toContain(':null');
        // add-путь: новый uid по максимуму ключей объекта
        const uids = Object.keys(data.entries).map(Number);
        const newUid = Math.max(...uids) + 1;
        expect(newUid).toBe(2);
        data.entries[newUid] = { uid: newUid, content: 'new' };
        expect(JSON.stringify(data)).not.toContain('null');
    });
});
