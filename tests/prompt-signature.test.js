// Сигнатура системного промпта — страховка кэша buildSystemContent.
// Контракт: мутации, не попадающие в промпт (stats), НЕ меняют подпись;
// живые входы (срез чата, персона, system_prompt, участники группы) — меняют.
import { describe, it, expect, beforeEach } from 'vitest';

import { _computeSystemPromptSignature } from '../src/api.js';

const baseSettings = () => ({
    contextDepth: 3,
    includeSystemPrompt: false,
    stats: { g: { '2026-10-28': [1, 2, 3] }, c: {}, ch: {} },
});

beforeEach(() => {
    const ctx = SillyTavern.getContext();
    ctx.chat = [
        { mes: 'one', is_user: true },
        { mes: 'two', is_user: false },
        { mes: 'three', is_user: true },
    ];
    ctx.chatCompletionSettings = {};
    ctx.groups = null;
    ctx.groupId = null;
    delete window.power_user;
});

describe('_computeSystemPromptSignature', () => {
    it('stats не влияют на подпись (иначе кэш умирает каждый ход)', () => {
        const s = baseSettings();
        const a = _computeSystemPromptSignature(s);
        s.stats.g['2026-10-28'].push(99);
        s.stats.c = { '5': { msg: 7 } };
        const b = _computeSystemPromptSignature(s);
        expect(b).toBe(a);
    });

    it('изменение хвоста чата меняет подпись (keyword-scan/roleplay_context)', () => {
        const s = baseSettings();
        const a = _computeSystemPromptSignature(s);
        SillyTavern.getContext().chat[2].mes = 'three EDITED';
        const b = _computeSystemPromptSignature(s);
        expect(b).not.toBe(a);
    });

    it('изменение персоны меняет подпись', () => {
        const s = baseSettings();
        const a = _computeSystemPromptSignature(s);
        window.power_user = { persona_description: 'Я gama-тестер' };
        const b = _computeSystemPromptSignature(s);
        expect(b).not.toBe(a);
    });

    it('system_prompt из настроек ST учитывается при includeSystemPrompt', () => {
        const s = baseSettings();
        const a = _computeSystemPromptSignature(s);
        SillyTavern.getContext().chatCompletionSettings.system_prompt = 'be terse';
        const withOff = _computeSystemPromptSignature(s); // includeSystemPrompt=false — не влияет
        s.includeSystemPrompt = true;
        const b = _computeSystemPromptSignature(s);
        expect(withOff).toBe(a);
        expect(b).not.toBe(a);
    });

    it('участники группы меняют подпись', () => {
        const ctx = SillyTavern.getContext();
        ctx.groupId = 'g1';
        ctx.groups = [{ id: 'g1', members: ['a.png', 'b.png'] }];
        const s = baseSettings();
        const a = _computeSystemPromptSignature(s);
        ctx.groups[0].members.push('c.png');
        const b = _computeSystemPromptSignature(s);
        expect(b).not.toBe(a);
    });

    it('глубина контекста ограничивает чувствительность к хвосту', () => {
        const ctx = SillyTavern.getContext();
        const s = baseSettings(); // contextDepth: 3
        const a = _computeSystemPromptSignature(s);
        ctx.chat.unshift({ mes: 'OLD-OUT-OF-WINDOW', is_user: true });
        expect(ctx.chat.length).toBe(4);
        const b = _computeSystemPromptSignature(s);
        expect(b).toBe(a); // старое сообщение за окном depth=3 не входит
    });
});
