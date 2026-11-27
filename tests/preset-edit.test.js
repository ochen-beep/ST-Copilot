import { describe, it, expect } from 'vitest';
import { parsePresetChangesFromText, stripPresetChangesBlock, _sanitizePresetChanges, buildPresetEditAIInstructions } from '../src/features/feature-presetedit-engine.js';

describe('parsePresetChangesFromText', () => {
    it('парсит валидный блок со всеми тремя операциями', () => {
        const text = 'Посмотрю пресет.\n```preset-changes\n{"preset": "My Preset", "changes": [\n' +
            '{"action":"add_variant","target_identifier":"main","content":"Новый текст"},\n' +
            '{"action":"edit","identifier":"abc","fields":{"injection_depth":6}},\n' +
            '{"action":"toggle","identifier":"abc","enabled":false}\n]}\n```\nГотово.';
        const ops = parsePresetChangesFromText(text);
        expect(ops).toHaveLength(3);
        expect(ops[0]).toEqual({ action: 'add_variant', target_identifier: 'main', content: 'Новый текст', role: undefined });
        expect(ops[1]).toEqual({ action: 'edit', identifier: 'abc', fields: { injection_depth: 6 } });
        expect(ops[2]).toEqual({ action: 'toggle', identifier: 'abc', enabled: false });
    });

    it('чинит битый JSON (trailing comma) через лестницу починки', () => {
        const text = '```preset-changes\n{"preset": "P", "changes": [{"action":"toggle","identifier":"x","enabled":true},]}\n```';
        const ops = parsePresetChangesFromText(text);
        expect(ops).toEqual([{ action: 'toggle', identifier: 'x', enabled: true }]);
    });

    it('мусор без блока — null', () => {
        expect(parsePresetChangesFromText('никаких блоков')).toBeNull();
        expect(parsePresetChangesFromText('')).toBeNull();
    });
});

describe('_sanitizePresetChanges — гейты', () => {
    it('отбрасывает неизвестные action и пустые ops', () => {
        expect(_sanitizePresetChanges([
            { action: 'delete', identifier: 'x' },
            { action: 'edit', identifier: 'x', fields: {} },
            { action: 'toggle' },
            null,
            'строка',
        ])).toBeNull();
    });

    it('add_variant требует непустой content и target_identifier', () => {
        expect(_sanitizePresetChanges([
            { action: 'add_variant', target_identifier: 'main', content: '   ' },
            { action: 'add_variant', content: 'текст' },
            { action: 'add_variant', target_identifier: 'main', content: 'ок' },
        ])).toEqual([{ action: 'add_variant', target_identifier: 'main', content: 'ок', role: undefined }]);
    });

    it('edit оставляет только поля из белого списка и валидирует значения', () => {
        const ops = _sanitizePresetChanges([{ action: 'edit', identifier: 'x', fields: {
            name: 'Новое имя', content: 'текст', hack: true,
            role: 'admin', injection_position: 1, injection_depth: '12', injection_order: -5,
        } }]);
        expect(ops).toEqual([{ action: 'edit', identifier: 'x', fields: {
            name: 'Новое имя', content: 'текст', injection_position: 1, injection_depth: 12, injection_order: 0,
        } }]);
    });

    it('toggle без enabled — переворачивающий (undefined)', () => {
        expect(_sanitizePresetChanges([{ action: 'toggle', identifier: 'x' }]))
            .toEqual([{ action: 'toggle', identifier: 'x', enabled: undefined }]);
    });
});

describe('stripPresetChangesBlock', () => {
    it('убирает закрытый и незакрытый блок', () => {
        const closed = 'до ```preset-changes\n{"changes":[]}\n``` после';
        expect(stripPresetChangesBlock(closed)).toBe('до  после');
        const open = 'до ```preset-changes\n{"changes":[]}';
        expect(stripPresetChangesBlock(open)).toBe('до');
    });
});

describe('buildPresetEditAIInstructions — тумблер', () => {
    it('выключен — пустая строка', () => {
        expect(buildPresetEditAIInstructions({ presetEditAIEnabled: false })).toBe('');
    });
    it('включён — директива с формат-блоком', () => {
        const s = buildPresetEditAIInstructions({ presetEditAIEnabled: true });
        expect(s).toContain('<preset_editing>');
        expect(s).toContain('```preset-changes');
        expect(s).toContain('add_variant');
    });
});
