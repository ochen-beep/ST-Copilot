// applyChatChanges: UI опирается на возвращаемый список фактически применённых
// изменений — несовпавший якорь не должен попадать в «применённые».
import { describe, it, expect, beforeEach } from 'vitest';

import { applyChatChanges } from '../src/features/feature-chatedit-engine.js';

describe('applyChatChanges возвращает только применённые изменения', () => {
    beforeEach(() => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'hello world', is_user: false },
            { mes: 'second message', is_user: true },
        ];
        ctx.saveChat = async () => {};
    });

    it('совпавший якорь: правка применяется и возвращается', async () => {
        const change = { action: 'replace', msg_index: 0, patches: [{ search: 'hello', replace: 'bye' }] };
        const applied = await applyChatChanges([change]);
        expect(applied).toEqual([change]);
        expect(SillyTavern.getContext().chat[0].mes).toBe('bye world');
    });

    it('несовпавший якорь: правка НЕ возвращается, сообщение не тронуто', async () => {
        const change = { action: 'replace', msg_index: 0, patches: [{ search: 'ZZZ-НЕТ-ТАКОГО', replace: 'x' }] };
        const applied = await applyChatChanges([change]);
        expect(applied).toEqual([]);
        expect(SillyTavern.getContext().chat[0].mes).toBe('hello world');
    });

    it('delete с несуществующим индексом не попадает в применённые', async () => {
        const ok = { action: 'overwrite', msg_index: 1, content: 'rewritten' };
        const bad = { action: 'delete', msg_indices: [99] };
        const applied = await applyChatChanges([ok, bad]);
        expect(applied).toEqual([ok]);
        expect(SillyTavern.getContext().chat).toHaveLength(2);
        expect(SillyTavern.getContext().chat[1].mes).toBe('rewritten');
    });
});
