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

    it('одиночный delete удаляет ровно одно сообщение при сплайсингом deleteMessage ядра ST', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'm0', is_user: false },
            { mes: 'm1', is_user: true },
            { mes: 'm2', is_user: false },
        ];
        // Ядро ST внутри deleteMessage() само делает chat.splice(id, 1) над тем же
        // массивом — движок не должен дублировать удаление.
        ctx.deleteMessage = (i) => { ctx.chat.splice(i, 1); };
        const applied = await applyChatChanges([{ action: 'delete', msg_index: 1 }]);
        expect(applied).toHaveLength(1);
        expect(ctx.chat).toHaveLength(2);
        expect(ctx.chat.map(m => m.mes)).toEqual(['m0', 'm2']);
    });

    it('delete в батче сдвигает индексы последующих изменений', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'm0', is_user: false },
            { mes: 'm1', is_user: true },
            { mes: 'm2', is_user: false },
            { mes: 'm3', is_user: true },
        ];
        const applied = await applyChatChanges([
            { action: 'delete', msg_index: 1 },
            { action: 'overwrite', msg_index: 2, content: 'rewritten-m2' },
        ]);
        expect(applied).toHaveLength(2);
        expect(ctx.chat.map(m => m.mes)).toEqual(['m0', 'rewritten-m2', 'm3']);
    });

    it('add в батче сдвигает индексы последующих изменений', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'm0', is_user: false },
            { mes: 'm1', is_user: true },
            { mes: 'm2', is_user: false },
        ];
        const applied = await applyChatChanges([
            { action: 'add', msg_index: 1, role: 'user', content: 'NEW' },
            { action: 'overwrite', msg_index: 2, content: 'rewritten-m2' },
        ]);
        expect(applied).toHaveLength(2);
        expect(ctx.chat.map(m => m.mes)).toEqual(['m0', 'NEW', 'm1', 'rewritten-m2']);
    });
});
