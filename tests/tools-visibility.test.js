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
});
