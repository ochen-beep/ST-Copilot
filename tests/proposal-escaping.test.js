// Regression on a real report: the chat system prompt demonstrates ESCAPED
// formatting (\`\`\` fences), the model imitates it and proposal blocks arrive
// with escaped fences and escaped quotes — parsers missed them entirely and
// the user got changes that could not be applied.
import { describe, it, expect, beforeEach } from 'vitest';

let lb, chat, char;

beforeEach(async () => {
    lb = await import('../src/features/feature-lorebook-engine.js');
    chat = await import('../src/features/feature-chatedit-engine.js');
    char = await import('../src/features/feature-character-engine-parse.js');
});

describe('proposal parsers accept escaped fences and quotes', () => {
    it('lorebook: escaped fences + escaped quotes parse into changes', () => {
        const text = '\\`\\`\\`lorebook-changes\n{\\"changes\\": [{\\"action\\": \\"edit\\", \\"name\\": \\"003 - Матримониальное планирование\\", \\"content\\": \\"Стас — не банкир\\"}]}\n\\`\\`\\`';
        const changes = lb.parseLBChangesFromText(text);
        expect(changes).not.toBeNull();
        expect(changes).toHaveLength(1);
        expect(changes[0].action).toBe('edit');
        expect(changes[0].name).toContain('003');
    });

    it('lorebook: plain fences + escaped quotes (fence fine, JSON escaped)', () => {
        const text = '```lorebook-changes\n{\\"changes\\": [{\\"action\\": \\"patch\\", \\"name\\": \\"X\\"}]}\n```';
        const changes = lb.parseLBChangesFromText(text);
        expect(changes).not.toBeNull();
        expect(changes[0].action).toBe('patch');
    });

    it('lorebook: plain fences + plain JSON still parse (no regression)', () => {
        const text = '```lorebook-changes\n{"changes": [{"action": "add", "name": "New", "content": "C"}]}\n```';
        const changes = lb.parseLBChangesFromText(text);
        expect(changes).not.toBeNull();
        expect(changes[0].action).toBe('add');
    });

    it('lorebook: strip removes escaped-fence block', () => {
        const text = 'до\n\\`\\`\\`lorebook-changes\n{"changes": []}\n\\`\\`\\`\nпосле';
        const stripped = lb.stripLBChangesBlock(text);
        expect(stripped).toContain('до');
        expect(stripped).toContain('после');
        expect(stripped).not.toContain('lorebook-changes');
    });

    it('lorebook: strip removes plain-fence block (no regression)', () => {
        const text = 'до\n```lorebook-changes\n{"changes": []}\n```\nпосле';
        const stripped = lb.stripLBChangesBlock(text);
        expect(stripped).not.toContain('lorebook-changes');
    });

    it('chat: escaped fences + quotes parse into changes', () => {
        const text = '\\`\\`\\`chat-changes\n{\\"changes\\": [{\\"action\\": \\"replace\\", \\"msg_indices\\": [4], \\"find_text\\": \\"а\\", \\"replace_text\\": \\"б\\"}]}\n\\`\\`\\`';
        const changes = chat.parseChatChangesFromText(text);
        expect(changes).not.toBeNull();
        expect(changes[0].action).toBe('replace');
    });

    it('chat: strip removes escaped-fence block', () => {
        const text = 'до\n\\`\\`\\`chat-changes\n{}\n\\`\\`\\`\nпосле';
        const stripped = chat.stripChatChangesBlock(text);
        expect(stripped).not.toContain('chat-changes');
    });

    it('character: escaped fences parse into changes (overwrite tag)', () => {
        const text = '\\`\\`\\`character-changes\n<overwrite field=\\"description\\">New description</overwrite>\n\\`\\`\\`';
        const changes = char.parseCharChangesFromText(text);
        expect(changes).not.toBeNull();
        expect(changes).toHaveLength(1);
        expect(changes[0].field).toBe('description');
        expect(changes[0].action).toBe('overwrite');
    });

    it('character creation: escaped fences + quotes parse', () => {
        const text = '\\`\\`\\`character-creation\n{\\"name\\": \\"Stas\\", \\"description\\": \\"D\\"}\n\\`\\`\\`';
        const data = char.parseCharCreationFromText(text);
        expect(data).not.toBeNull();
        expect(data.name).toBe('Stas');
    });
});
