// Памяти ключуются на стабильный avatar персонажа (не volatile-индекс ростера),
// старые записи мигрируют один раз; повторные add от модели дедуплицируются и
// ограничены по длине значения.
import { describe, it, expect, beforeEach } from 'vitest';

import { getVisibleMemories, addMemory, processMemoryUpdates, getMemories } from '../src/features/feature-memory.js';

const EXT_KEY = 'st_copilot';
const settings = () => SillyTavern.getContext().extensionSettings[EXT_KEY];

beforeEach(() => {
    const ctx = SillyTavern.getContext();
    ctx.extensionSettings[EXT_KEY] = {};
    ctx.characterId = 5;
    ctx.characters = [];
    ctx.characters[5] = { avatar: 'Seraphina.png', name: 'Seraphina' };
    ctx.chat = [];
    delete window.power_user;
});

describe('ключ персонажа', () => {
    it('addMemory сохраняет avatar вместо индекса', () => {
        addMemory('Любимый чай', 'улун', 'character');
        const mem = Object.values(settings().memories)[0];
        expect(mem.charId).toBe('Seraphina.png');
    });

    it('индексные записи мигрируют на avatar один раз, чужие — остаются сиротами', () => {
        SillyTavern.getContext().characters[6] = { avatar: 'Other.png', name: 'Кто-то другой' };
        settings().memories = {
            m1: { id: 'm1', scope: 'character', key: 'K', value: 'V', charId: '5', charName: 'Seraphina', disabled: false },
            m2: { id: 'm2', scope: 'chat', key: 'K2', value: 'V2', charId: '9', charName: 'Пропал', disabled: false }, // персонажа 9 нет
            m3: { id: 'm3', scope: 'character', key: 'K3', value: 'V3', charId: '6', charName: 'Было другое имя', disabled: false }, // ростер сдвинулся
        };
        const visible = getVisibleMemories();
        expect(visible.map(m => m.id)).toEqual(['m1']);
        expect(settings().memories.m1.charId).toBe('Seraphina.png'); // переписан по совпадению имени
        expect(settings().memories.m2.charId).toBe('9');             // персонаж исчез — сирота
        expect(settings().memories.m3.charId).toBe('6');             // индекс занял другой персонаж
        expect(settings().memKeyMigrated).toBe(true);
    });
});

describe('повторные add от модели', () => {
    const block = (changes) => 'text\n```memory-update\n' + JSON.stringify(changes) + '\n```\nend';

    it('точный дубликат не аппендится', () => {
        addMemory('Ключ', 'значение', 'character');
        processMemoryUpdates(block([{ action: 'add', scope: 'character', key: 'Ключ', value: 'значение' }]), 'msg1');
        expect(getMemories().m0?.value ?? Object.values(getMemories())[0].value).toBe('значение');
    });

    it('новая строка аппендится, но значение ограничено капом', () => {
        const long = 'x'.repeat(3900);
        addMemory('Ключ', long, 'character');
        processMemoryUpdates(block([
            { action: 'add', scope: 'character', key: 'Ключ', value: 'NEW-TAIL' },
            { action: 'add', scope: 'character', key: 'Ключ', value: 'NEW-TAIL-2' },
        ]), 'msg1');
        const mem = Object.values(getMemories())[0];
        expect(mem.value.endsWith('NEW-TAIL-2')).toBe(true);
        expect(mem.value.length).toBeLessThanOrEqual(4001); // кап + многоточие
    });
});
