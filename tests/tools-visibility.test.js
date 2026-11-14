// Tools must share the prompt-builder visibility contract: hidden ST messages
// (/hide marks is_system) stay invisible unless includeHiddenMessages is on;
// sc_ghosted (the extension's own ghosting) always hides.
import { describe, it, expect, beforeEach } from 'vitest';

let engine;
const ctx = SillyTavern.getContext();

function seedSettings(over = {}) {
    ctx.extensionSettings['st_copilot'] = {
        toolsEnabled: true,
        includeHiddenMessages: false,
        ...over,
    };
}

beforeEach(async () => {
    engine = await import('../src/features/feature-tools-engine.js');
    ctx.chat = [
        { mes: 'visible user', is_user: true, name: 'User' },
        { mes: 'SECRET hidden reply', is_user: false, is_system: true, name: 'Char' },
        { mes: 'GHOST ghosted text', is_user: false, extra: { sc_ghosted: true }, name: 'Char' },
        { mes: 'visible assistant reply', is_user: false, name: 'Char' },
    ];
    seedSettings();
});

describe('chat tools respect message visibility', () => {
    it('search_chat skips hidden messages by default', async () => {
        const r = await engine.executeTool('search_chat', { queries: ['SECRET'] });
        expect(r.found).toBe(0);
    });

    it('search_chat finds hidden messages when includeHiddenMessages is on', async () => {
        seedSettings({ includeHiddenMessages: true });
        const r = await engine.executeTool('search_chat', { queries: ['SECRET'] });
        expect(r.found).toBe(1);
        expect(r.results[0].content).toContain('SECRET');
    });

    it('search_chat never returns sc_ghosted messages', async () => {
        seedSettings({ includeHiddenMessages: true });
        const r = await engine.executeTool('search_chat', { queries: ['GHOST'] });
        expect(r.found).toBe(0);
    });

    it('get_recent_messages excludes hidden by default', async () => {
        const r = await engine.executeTool('get_recent_messages', { count: 10 });
        const contents = r.messages.map(m => m.content).join('\n');
        expect(contents).not.toContain('SECRET');
        expect(contents).not.toContain('GHOST');
        expect(contents).toContain('visible assistant reply');
    });

    it('get_chat_stats counts only visible messages by default', async () => {
        const r = await engine.executeTool('get_chat_stats', {});
        expect(r.total_messages).toBe(2);
    });

    it('session override can enable hidden messages for tools', async () => {
        // effective settings: session overrides must apply to tools too
        const crud = await import('../src/session.js');
        const sess = crud.createSession(undefined, false, false);
        crud.setActiveSession(sess.id);
        crud.setSessionOverride('includeHiddenMessages', true);
        const r = await engine.executeTool('search_chat', { queries: ['SECRET'] });
        expect(r.found).toBe(1);
    });
});

describe('lorebook tools respect excluded books and disabled entries', () => {
    beforeEach(() => {
        window.selected_world_info = ['ToolBook', 'ExcludedBook'];
        ctx.loadWorldInfo = async (name) => {
            if (name === 'ToolBook') return { name, entries: {
                0: { uid: 0, comment: 'Enabled', content: 'enabled lore text', key: ['e'], disable: false },
                1: { uid: 1, comment: 'DisabledLore', content: 'secret disabled lore', key: ['d'], disable: true },
            } };
            if (name === 'ExcludedBook') return { name, entries: {
                0: { uid: 0, comment: 'ExcludedLore', content: 'excluded book lore', key: ['x'], disable: false },
            } };
            return null;
        };
    });

    it('search_lorebook_entry skips disabled entries and excluded books', async () => {
        seedSettings({ lorebookExcludedBooks: ['ExcludedBook'] });
        const r = await engine.executeTool('search_lorebook_entry', { queries: ['lore'] });
        const names = r.results.map(x => x.name);
        expect(names).toContain('Enabled');
        expect(names).not.toContain('DisabledLore');
        expect(names).not.toContain('ExcludedLore');
    });

    it('search_lorebook_entry returns disabled entry when user forced it on', async () => {
        seedSettings({ lorebookExcludedBooks: [], lorebookEntryOverrides: { 'ToolBook_DisabledLore': true } });
        const r = await engine.executeTool('search_lorebook_entry', { queries: ['secret disabled'] });
        expect(r.found).toBe(1);
        expect(r.results[0].name).toBe('DisabledLore');
        expect(r.results[0].disabled).toBe(true);
    });

    it('get_lorebooks hides excluded books and disabled entries', async () => {
        seedSettings({ lorebookExcludedBooks: ['ExcludedBook'] });
        const r = await engine.executeTool('get_lorebooks', {});
        const names = r.lorebooks.map(b => b.name);
        expect(names).toContain('ToolBook');
        expect(names).not.toContain('ExcludedBook');

        const r2 = await engine.executeTool('get_lorebooks', { include_entries: true, book_name: 'ToolBook' });
        const entryNames = r2.lorebooks['ToolBook'].map(e => e.name);
        expect(entryNames).toContain('Enabled');
        expect(entryNames).not.toContain('DisabledLore');
    });

    it('excluded book matches despite stray spaces in the stored name', async () => {
        seedSettings({ lorebookExcludedBooks: [' ExcludedBook '] });
        const r = await engine.executeTool('search_lorebook_entry', { queries: ['excluded book lore'] });
        expect(r.found).toBe(0);
    });

    it('get_lorebooks book_name matches by substring and reports not-found clearly', async () => {
        seedSettings({ lorebookExcludedBooks: [] });
        window.selected_world_info = ['ToolBook'];
        const r = await engine.executeTool('get_lorebooks', { include_entries: true, book_name: 'ool' });
        expect(Object.keys(r.lorebooks)).toContain('ToolBook');

        const miss = await engine.executeTool('get_lorebooks', { include_entries: true, book_name: 'zzz-nonexistent' });
        expect(miss.error).toContain('zzz-nonexistent');
        expect(miss.error).toContain('ToolBook');
    });

    it('full=true returns complete entry content; default preview carries a hint', async () => {
        seedSettings({ lorebookExcludedBooks: [] });
        const long = 'X'.repeat(300) + ' EXACT TAIL';
        // уникальное имя книги: wiCache живёт 30 с и переживает соседние тесты
        ctx.loadWorldInfo = async (name) => name === 'FullContentBook' ? { name, entries: {
            0: { uid: 0, comment: 'LongEntry', content: long, key: ['e'], disable: false },
        } } : null;
        window.selected_world_info = ['FullContentBook'];
        const preview = await engine.executeTool('search_lorebook_entry', { queries: ['LongEntry'] });
        expect(preview.results[0].content_preview).toContain('truncated');
        expect(preview.results[0].content_preview).not.toContain('EXACT TAIL');
        expect(preview.results[0].content_preview).toContain('full:true');

        const full = await engine.executeTool('search_lorebook_entry', { queries: ['LongEntry'], full: true });
        expect(full.results[0].content).toBe(long);
        expect(full.results[0].content_preview).toBeUndefined();
    });
});

describe('lorebook tool gating', () => {
    it('lorebook tools disappear when lorebook AI management is off', async () => {
        seedSettings({ lorebookAIManageEnabled: false });
        const names = engine.getEnabledTools().map(t => t.name);
        expect(names).not.toContain('search_lorebook_entry');
        expect(names).not.toContain('get_lorebooks');
        expect(names).toContain('search_chat');
    });

    it('lorebook tools stay available when management is on (default)', async () => {
        seedSettings({ lorebookAIManageEnabled: true });
        const names = engine.getEnabledTools().map(t => t.name);
        expect(names).toContain('search_lorebook_entry');
        expect(names).toContain('get_lorebooks');
    });
});

describe('context builder: book-level include must not resurrect ST-disabled entries', () => {
    it('selected book injects only active entries; explicit per-entry force still works', async () => {
        window.selected_world_info = ['TestBook'];
        ctx.loadWorldInfo = async () => ({ name: 'TestBook', entries: {
            0: { uid: 0, comment: 'ActiveLore', content: 'ACTIVE CONTENT', key: ['a'], disable: false },
            1: { uid: 1, comment: 'OffLore', content: 'DISABLED CONTENT', key: ['o'], disable: true },
            2: { uid: 2, comment: 'ForcedLore', content: 'FORCED CONTENT', key: ['f'], disable: true },
        } });
        const lb = await import('../src/features/feature-lorebook-engine.js');
        const settings = {
            lorebookSelectedBooks: ['TestBook'],
            lorebookExcludedBooks: [],
            lorebookAutoKeyword: false,
            lorebookEntryOverrides: { 'TestBook_ForcedLore': true },
        };
        const block = await lb.buildLorebookContextBlock(settings);
        expect(block).toContain('ACTIVE CONTENT');
        expect(block).not.toContain('DISABLED CONTENT');
        expect(block).toContain('FORCED CONTENT');
    });
});
