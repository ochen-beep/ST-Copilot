// Пайплайн правок: толерантный парсинг character-changes, строгий резолв
// персонажей в группах, точный таргетинг lorebook-записей.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/state.js', () => ({ invalidateSystemPromptCache: () => {} }));
vi.mock('../src/utils/util-debug.js', () => ({ _dbgAdd: () => {}, _dbgDiffSettings: () => {} }));

import {
    parseCharChangesFromText,
    stripCharChangesBlock,
    parseCharCreationFromText,
    resolveCharacterByName,
    groupChangesByCharacter,
} from '../src/features/feature-character-engine.js';

const stubCtx = (extra = {}) => {
    const ctx = SillyTavern.getContext();
    Object.assign(ctx, {
        characters: [{ name: 'Aria', avatar: 'aria.png' }],
        characterId: 0,
        name1: 'John',
        groups: undefined,
        groupId: undefined,
        ...extra,
    });
    return ctx;
};

describe('толерантный парсинг character-changes', () => {
    beforeEach(() => stubCtx());

    it('атрибуты в одинарных кавычках', () => {
        const changes = parseCharChangesFromText("```character-changes\n<overwrite field='description'>Новая.description</overwrite>\n```");
        expect(changes).toHaveLength(1);
        expect(changes[0].field).toBe('description');
    });

    it('атрибуты без кавычек и с пробелами вокруг =', () => {
        const changes = parseCharChangesFromText('```character-changes\n<overwrite field = personality >Спокойная.</overwrite>\n```');
        expect(changes).toHaveLength(1);
        expect(changes[0].field).toBe('personality');
    });

    it('алиасы полей: first message → first_mes, "Author\'s Note" → authors_note', () => {
        const changes = parseCharChangesFromText(
            '```character-changes\n' +
            '<overwrite field="first message">Привет!</overwrite>\n' +
            '<append_text field="Author\'s Note">Внимание.</append_text>\n' +
            '```'
        );
        expect(changes).toHaveLength(2);
        expect(changes[0].field).toBe('first_mes');
        expect(changes[1].field).toBe('authors_note');
    });

    it('имена блоков: character-edits и character-edit тоже парсятся', () => {
        for (const lang of ['character-edits', 'character-edit']) {
            const changes = parseCharChangesFromText(`\`\`\`${lang}\n<overwrite field="scenario">Ночь.</overwrite>\n\`\`\``);
            expect(changes, lang).toHaveLength(1);
            expect(changes[0].field).toBe('scenario');
        }
    });

    it('stripCharChangesBlock убирает и не-каноничные имена блоков', () => {
        const text = 'Текст до.\n```character-edits\n<overwrite field="x">y</overwrite>\n```\nТекст после.';
        expect(stripCharChangesBlock(text)).toBe('Текст до.\n\nТекст после.');
    });

    it('character-creation тоже понимается для карточек', () => {
        const data = parseCharCreationFromText('```character-creation\n{"name":"Борис","description":"Тест"}\n```');
        expect(data?.name).toBe('Борис');
    });

    it('регрессия: каноничный блок с SEARCH/REPLACE патчами парсится как раньше', () => {
        const changes = parseCharChangesFromText(
            '```character-changes\n' +
            '<replace field="description">\n' +
            '<<<<<<< SEARCH\nСтарый текст\n=======\nНовый текст\n>>>>>>> REPLACE\n' +
            '</replace>\n```'
        );
        expect(changes).toHaveLength(1);
        expect(changes[0].action).toBe('replace');
        expect(changes[0].patches[0].search).toBe('Старый текст');
    });
});

describe('строгий резолв персонажей', () => {
    it('в группе неточное имя не угадывается — правка отклоняется', () => {
        stubCtx({
            groupId: 'g1',
            groups: [{ id: 'g1', members: ['aria.png', 'boris.png'] }],
            characters: [
                { name: 'Aria the Bold', avatar: 'aria.png' },
                { name: 'Boris', avatar: 'boris.png' },
            ],
        });
        expect(resolveCharacterByName('Aria')).toBeNull();          // подстрока «Aria» ≠ «Aria the Bold»
        expect(resolveCharacterByName('Aria the Bold')?.avatar).toBe('aria.png'); // точное — проходит
        expect(resolveCharacterByName('boris')?.avatar).toBe('boris.png');        // регистр — ок
    });

    it('groupChangesByCharacter не пишет в чужую карточку при промахе', () => {
        stubCtx({
            groupId: 'g1',
            groups: [{ id: 'g1', members: ['aria.png', 'boris.png'] }],
            characters: [
                { name: 'Aria', avatar: 'aria.png' },
                { name: 'Boris', avatar: 'boris.png' },
            ],
        });
        const groups = groupChangesByCharacter([{ field: 'description', action: 'overwrite', value: 'X', char: 'Кто-то' }]);
        expect(groups).toEqual([]); // правка без адресата — ни в одну группу
    });

    it('в одиночном чате правка без имени адресуется единственному персонажу', () => {
        stubCtx();
        const groups = groupChangesByCharacter([{ field: 'description', action: 'overwrite', value: 'X', char: null }]);
        expect(groups).toHaveLength(1);
        expect(groups[0].char.avatar).toBe('aria.png');
    });
});
