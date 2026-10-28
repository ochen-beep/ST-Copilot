// Контракты фасадов после распила монолитов:
//   1. Статика: каждый `export { X } from './y.js'` в фасаде разрешается в
//      реальный экспорт целевого модуля (следуя цепочкам ре-экспортов).
//   2. Динамика: все ре-экспортированные имена фасада определены в рантайме.
// Пойманный однажды класс бага: цикл фасад→api→фасад материализовал биндинг
// как undefined под vite SSR — статическая проверка его НЕ видит, динамическая видит.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(fileURLToPath(import.meta.url), '../../src');

const FACADES = [
    'session.js',
    'api.js',
    'constants.js',
    'ui/ui-chat.js',
    'ui/ui-settings.js',
    'ui/ui-widgets.js',
    'features/feature-lorebook-ui.js',
    'features/feature-character-engine.js',
    'features/feature-character-ui.js',
];

function exportedNames(absFile, seen = new Set()) {
    if (seen.has(absFile)) return new Set();
    seen.add(absFile);
    const text = readFileSync(absFile, 'utf-8');
    const names = new Set();
    for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.add(m[1]);
    }
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?\s*;/gms)) {
        const target = m[2];
        let sub = new Set();
        if (target) {
            const abs = path.resolve(path.dirname(absFile), target);
            sub = exportedNames(abs, seen);
        }
        for (let part of m[1].split(',')) {
            part = part.trim();
            if (!part) continue;
            const [src, , alias] = part.split(/\s+/);
            if (target && sub.size && !sub.has(src)) continue; // битая связка — пропускаем
            names.add(alias || src);
        }
    }
    return names;
}

describe('фасады: статические связки ре-экспортов', () => {
    it('каждый `export { X } from` разрешается в экспорт цели', () => {
        const problems = [];
        for (const rel of FACADES) {
            const abs = path.join(SRC, rel);
            const text = readFileSync(abs, 'utf-8');
            for (const m of text.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];/gms)) {
                const target = path.resolve(path.dirname(abs), m[2]);
                const avail = exportedNames(target);
                for (let part of m[1].split(',')) {
                    part = part.trim();
                    if (!part) continue;
                    const src = part.split(/\s+/)[0];
                    if (!avail.has(src)) problems.push(`${rel}: "${src}" не экспортируется ${m[2]}`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('ничего из исторических экспортов фасада не потеряно', () => {
        // Список обязан покрывать всё, что импортируют другие модули и тесты
        // (сверено с git-историей при распиле; новая потеря = упавший импорт где-то).
        const mustHave = {
            'session.js': ['getSettings', 'saveSettings', 'getBindingKey', 'getStableCharId', 'initChatBucket',
                'commitBucketChanges', 'saveSessionFile', 'loadSessionFile', 'deleteSessionFile', 'getChatBucket',
                'createSession', 'getActiveSession', 'setActiveSession', 'deleteCurrentSession', 'getCurrentSession',
                'addMessage', 'getEffectiveSettings', 'getSessionOverrides', 'saveSessionsToMetadata', 'expandMacros'],
            'api.js': ['buildSystemContent', 'assembleMessages', 'estimateTokens', 'callGenerate', 'runGenerate',
                'runContinue', 'getMainChatSlice', 'redactRequestBody', 'logOutgoingRequest', 'formatPayloadAsText'],
            'ui/ui-chat.js': ['renderMarkdown', 'postProcessHTMLBlocks', 'getDisplayContent', 'createMsgEl',
                '_renderMsgBodyContent', 'renderSession', 'appendMsgEl', 'updateMsgCount', 'onChatChanged',
                'setGeneratingState', 'showGenerationError', 'performSearch', 'openChatPicker', 'closeChatPicker',
                'setupSearchHotkey', 'setupDepthClickEdit', '_runSwipeRegen', 'handleEdit', 'handleDelete'],
            'ui/ui-widgets.js': ['playCompletionSound', 'setupChangelogListeners', 'checkChangelogAutoShow',
                'openFavoritesPanel', 'closeFavoritesPanel', 'openInspector', 'renderQuickPromptsBar'],
            'features/feature-lorebook-ui.js': ['applyLBChanges', 'renderProposalCard', 'appendLBHistoryEl'],
            'features/feature-character-engine.js': ['saveCharacterField', 'parseCharChangesFromText'],
            'features/feature-character-ui.js': ['applyCharChanges', 'renderCharProposalCard'],
            'constants.js': ['EXT_NAME', 'EXT_DISPLAY', 'CHANGELOG', 'QP_ICON_POOL', 'THEME_PRESETS'],
        };
        const problems = [];
        for (const [rel, names] of Object.entries(mustHave)) {
            const mod = exportedNames(path.join(SRC, rel));
            for (const n of names) {
                if (!mod.has(n)) problems.push(`${rel}: потерян экспорт "${n}"`);
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('фасады: динамическая загрузка (ловля undefined-биндингов циклов)', () => {
    for (const rel of FACADES) {
        it(`${rel}: все ре-экспорты определены в рантайме`, async () => {
            const abs = path.join(SRC, rel);
            const text = readFileSync(abs, 'utf-8');
            const names = new Set();
            for (const m of text.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?\s*;/gms)) {
                for (let part of m[1].split(',')) {
                    const words = part.trim().split(/\s+/).filter(Boolean);
                    if (!words.length) continue;
                    names.add(words[2] || words[0]);
                }
            }
            expect(names.size).toBeGreaterThan(0);
            const mod = await import(`../src/${rel}`);
            const missing = [...names].filter(n => mod[n] === undefined);
            expect(missing).toEqual([]);
        });
    }
});
