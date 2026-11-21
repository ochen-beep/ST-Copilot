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

describe('санитизация slash-команд из модельного вывода', () => {
    it('rename_chat: | в имени не пробрасывается в /renamechat', async () => {
        const ctx = SillyTavern.getContext();
        let captured = null;
        ctx.executeSlashCommandsWithOptions = async (cmd) => { captured = cmd; };
        try {
            const applied = await applyChatChanges([{ action: 'rename_chat', name: 'Чат | /sendas name="X" pwned' }]);
            expect(applied).toHaveLength(1);
            // | и {{}} нейтрализованы: без разделителя /sendas остаётся просто
            // частью имени, макросы не исполняются
            expect(captured).toBe('/renamechat Чат   /sendas name="X" pwned');
            expect(captured.includes('|')).toBe(false);
            expect(captured.includes('{{')).toBe(false);
        } finally {
            delete ctx.executeSlashCommandsWithOptions;
        }
    });

    it('hide: нечисловой msg_range отклоняется, не попадая в /hide', async () => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [{ mes: 'm0', is_user: false }, { mes: 'm1', is_user: true }];
        let captured = null;
        ctx.executeSlashCommandsWithOptions = async (cmd) => { captured = cmd; };
        try {
            const applied = await applyChatChanges([{ action: 'hide', msg_range: ['0 | /sendas evil', '0'] }]);
            // parseInt нейтрализует инъекцию: остаётся только безопасный диапазон
            expect(captured).toBe('/hide 0-0');
            expect(applied).toHaveLength(1);
        } finally {
            delete ctx.executeSlashCommandsWithOptions;
        }
    });
});

describe('send_date identity: proposals с датами переживают внешние сдвиги', () => {
    beforeEach(() => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'm0', is_user: false, send_date: 'January 1, 2026 10:00am' },
            { mes: 'm1', is_user: true, send_date: 'January 2, 2026 11:00am' },
            { mes: 'm2', is_user: false, send_date: 'January 3, 2026 12:00pm' },
        ];
        ctx.saveChat = async () => {};
    });

    it('delete: внешняя вставка сдвинула индекс — дата не совпала, чужое сообщение не удалено', async () => {
        const ctx = SillyTavern.getContext();
        // Proposal был на #2 (m2), но с тех пор в начало вставили чужое сообщение:
        // live #2 теперь m1 — дата не совпадёт, m1 должен выжить.
        ctx.chat.unshift({ mes: 'stranger', is_user: false, send_date: 'December 31, 2025 09:00am' });
        const applied = await applyChatChanges([
            { action: 'delete', msg_index: 2, msg_date: 'January 3, 2026 12:00pm' },
        ]);
        expect(applied).toHaveLength(0);
        expect(ctx.chat.map(m => m.mes)).toEqual(['stranger', 'm0', 'm1', 'm2']);
    });

    it('delete: дата совпала по новому индексу — удаление работает', async () => {
        const ctx = SillyTavern.getContext();
        // m1 уехал на #2 после внешней вставки; proposal скормили уже
        // актуализированный индекс с правильной датой.
        ctx.chat.unshift({ mes: 'stranger', is_user: false, send_date: 'December 31, 2025 09:00am' });
        const applied = await applyChatChanges([
            { action: 'delete', msg_index: 2, msg_date: 'January 2, 2026 11:00am' },
        ]);
        expect(applied).toHaveLength(1);
        expect(ctx.chat.map(m => m.mes)).toEqual(['stranger', 'm0', 'm2']);
    });

    it('overwrite без даты — легаси-поведение (применяется как раньше)', async () => {
        const applied = await applyChatChanges([
            { action: 'overwrite', msg_index: 1, content: 'rewritten' },
        ]);
        expect(applied).toHaveLength(1);
        expect(SillyTavern.getContext().chat[1].mes).toBe('rewritten');
    });

    it('bulk_replace: частичное несовпадение дат — мимо-сообщения исключены', async () => {
        const ctx = SillyTavern.getContext();
        const applied = await applyChatChanges([
            { action: 'bulk_replace', msg_indices: [0, 2], msg_dates: ['НЕВЕРНАЯ ДАТА', 'January 3, 2026 12:00pm'], replacements: [{ anchor: 'm', replace: 'X' }] },
        ]);
        expect(applied).toHaveLength(1);
        expect(ctx.chat[0].mes).toBe('m0');
        expect(ctx.chat[2].mes).toBe('X2');
    });

    it('msg_dates выравниваются по msg_indices, не по позиции после shift', async () => {
        const ctx = SillyTavern.getContext();
        // delete #0 внутри батча сдвигает m1/m2; второй change адресует #2 (m2
        // в оригинальной нумерации) — дата m2 должна совпасть после сдвига.
        const applied = await applyChatChanges([
            { action: 'delete', msg_index: 0, msg_date: 'January 1, 2026 10:00am' },
            { action: 'overwrite', msg_index: 2, msg_date: 'January 3, 2026 12:00pm', content: 'rewritten-m2' },
        ]);
        expect(applied).toHaveLength(2);
        expect(ctx.chat.map(m => m.mes)).toEqual(['m1', 'rewritten-m2']);
    });
});

// Fabricated msg_date (model recalled a date without a fresh snapshot this
// turn) must not block an edit whose anchors prove identity — the Christopher
// false-block. Anchors only land on content the model actually saw.
describe('fabricated msg_date: якоря доказывают идентичность лучше даты', () => {
    beforeEach(() => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'POV Тим. Cheap vietnamese eateries.', is_user: false, send_date: '2026-11-08T11:58:02.191Z' },
            { mes: 'm1', is_user: true, send_date: '2026-11-09T10:00:00.000Z' },
        ];
        ctx.saveChat = async () => {};
    });

    it('bulk_replace: дата выдумана, якорь совпал — правка применяется', async () => {
        const applied = await applyChatChanges([{
            action: 'bulk_replace',
            msg_indices: [0],
            msg_dates: ['2026-03-30T17:34:03.111Z'],
            replacements: [{ search: 'Cheap vietnamese eateries', replace: 'generic campus eateries' }],
        }]);
        expect(applied).toHaveLength(1);
        expect(SillyTavern.getContext().chat[0].mes).toBe('POV Тим. generic campus eateries.');
    });

    it('bulk_replace: дата выдумана и якорь не совпал — пропуск (защита жива)', async () => {
        const applied = await applyChatChanges([{
            action: 'bulk_replace',
            msg_indices: [0],
            msg_dates: ['2026-03-30T17:34:03.111Z'],
            replacements: [{ search: 'ZZZ-НЕТ-ТАКОГО', replace: 'x' }],
        }]);
        expect(applied).toHaveLength(1); // изменение вернулось с affectedCount: 0
        expect(SillyTavern.getContext().chat[0].mes).toContain('Cheap vietnamese');
    });

    it('replace: дата выдумана, все якоря совпали — применяется', async () => {
        const applied = await applyChatChanges([{
            action: 'replace',
            msg_index: 0,
            msg_date: '2026-03-30T17:34:03.111Z',
            patches: [{ search: 'vietnamese eateries', replace: 'campus eateries' }],
        }]);
        expect(applied).toHaveLength(1);
        expect(SillyTavern.getContext().chat[0].mes).toBe('POV Тим. Cheap campus eateries.');
    });

    it('overwrite с выдуманной датой по-прежнему блокируется (нет якорей)', async () => {
        const applied = await applyChatChanges([{
            action: 'overwrite',
            msg_index: 0,
            msg_date: '2026-03-30T17:34:03.111Z',
            content: 'hijacked',
        }]);
        expect(applied).toHaveLength(0);
        expect(SillyTavern.getContext().chat[0].mes).toContain('Cheap vietnamese');
    });
});

// The apply outcome is a persisted signal: one CHATEDIT_APPLIED line with
// applied/total counts lands in the debug ring for every apply attempt.
describe('applyChatChanges emits CHATEDIT_APPLIED', () => {
    beforeEach(() => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'm0', is_user: false },
            { mes: 'm1', is_user: true },
        ];
        ctx.saveChat = async () => {};
    });

    it('records applied/total after an apply attempt', async () => {
        const { DBG_STATE } = await import('../src/state.js');
        const before = DBG_STATE.log.length;
        await applyChatChanges([
            { action: 'replace', msg_index: 0, patches: [{ search: 'm0', replace: 'M0' }] },
            { action: 'replace', msg_index: 0, patches: [{ search: 'ZZZ-НЕТ', replace: 'x' }] },
        ]);
        const ev = DBG_STATE.log.slice(before).find(e => e.type === 'CHATEDIT_APPLIED');
        expect(ev).toBeTruthy();
        expect(ev.payload).toEqual({ applied: 1, total: 2 });
    });
});

describe('applyChatChanges: fabricated msg_dates + anchor fallback (msg_indices)', () => {
    beforeEach(() => {
        const ctx = SillyTavern.getContext();
        ctx.chat = [
            { mes: 'а не слушать || на пятилетку.', is_user: true, send_date: '2026-03-28T03:07:01.595Z' },
            { mes: 'Боги, Кроу, смылись || с ручника.', is_user: false, send_date: '2026-03-28T19:01:59.989Z' },
            { mes: ' filler ', is_user: false, send_date: '2026-03-28T20:00:00.000Z' },
        ];
        ctx.saveChat = async () => {};
        ctx.saveChatConditional = async () => {};
    });

    it('replace с выдуманными датами и конкретными якорями применяется по якорям', async () => {
        // One change per message: every patch of a change targets that message.
        const changes = [
            {
                action: 'replace',
                msg_indices: [0],
                msg_dates: ['2026-03-28T22:31:39.117Z'],
                patches: [{ search: 'а не слушать || на пятилетку.', replace: 'а не слушать ваши планы на годы вперёд.' }],
            },
            {
                action: 'replace',
                msg_indices: [1],
                msg_dates: ['2026-03-28T23:02:12.784Z'],
                patches: [{ search: 'смылись || с ручника.', replace: 'очинись уже.' }],
            },
        ];
        const applied = await applyChatChanges(changes);
        expect(applied).toEqual(changes);
        expect(SillyTavern.getContext().chat[0].mes).toContain('ваши планы');
        expect(SillyTavern.getContext().chat[1].mes).toContain('очинись');
    });

    it('replace с выдуманными датами и короткими якорями пропускается', async () => {
        const change = {
            action: 'replace',
            msg_indices: [0],
            msg_dates: ['2026-03-28T22:31:39.117Z'],
            patches: [{ search: 'а не', replace: 'X' }],
        };
        const applied = await applyChatChanges([change]);
        expect(applied).toEqual([]);
        expect(SillyTavern.getContext().chat[0].mes).toBe('а не слушать || на пятилетку.');
    });

    it('delete с выдуманными датами по-прежнему жёстко пропускается', async () => {
        const change = { action: 'delete', msg_indices: [0], msg_dates: ['2026-03-28T22:31:39.117Z'] };
        const applied = await applyChatChanges([change]);
        expect(applied).toEqual([]);
        expect(SillyTavern.getContext().chat).toHaveLength(3);
    });
});
