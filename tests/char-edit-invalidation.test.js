// Правки authors_note / user_persona / evolutia-полей персоны идут в обход
// extension-обёртки saveSettings() и обязаны сами ронять кэш системного промпта
// (иначе блоки <authors_note>/<{{user}}_persona> застывают до случайной инвалидации).
import { describe, it, expect, beforeEach } from 'vitest';

import { saveCharacterField } from '../src/features/feature-character-engine.js';
import { state } from '../src/state.js';

const markClean = () => {
    state.systemPromptDirty = false;
    state.systemPromptCache = Promise.resolve('sentinel');
    state.systemPromptSig = 'x';
};

describe('saveCharacterField инвалидирует кэш системного промпта', () => {
    beforeEach(() => {
        SillyTavern.getContext().chatMetadata = {};
    });

    it('authors_note: пишем note_prompt и роняем кэш', async () => {
        markClean();
        await saveCharacterField({}, 'authors_note', 'новая заметка');
        expect(state.systemPromptDirty).toBe(true);
        expect(SillyTavern.getContext().chatMetadata.note_prompt).toBe('новая заметка');
    });

    it('user_persona: fallback в power_user без сети, кэш уронен', async () => {
        markClean();
        window.power_user = {};
        try {
            await saveCharacterField({}, 'user_persona', 'новая персона');
            expect(state.systemPromptDirty).toBe(true);
            expect(window.power_user.persona_description).toBe('новая персона');
        } finally {
            delete window.power_user;
        }
    });

    it('evolutia_user:<поле>: правится контент альтер-эго, кэш уронен', async () => {
        markClean();
        window.power_user = {
            'st-description-swap-fields': {
                personaDynamicFields: {
                    p1: { activeAlterEgoId: 'base', alterEgos: [{ id: 'base', fields: [{ name: 'Цель', content: 'old' }] }] },
                },
            },
        };
        window.user_avatar = 'p1';
        try {
            await saveCharacterField({}, 'evolutia_user:Цель', 'new content');
            expect(state.systemPromptDirty).toBe(true);
            const f = window.power_user['st-description-swap-fields']
                .personaDynamicFields.p1.alterEgos[0].fields[0];
            expect(f.content).toBe('new content');
        } finally {
            delete window.power_user;
            delete window.user_avatar;
        }
    });
});
