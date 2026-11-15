// The output-format contract is code-owned: whatever the user writes in the
// editable prompts, the model must always see the block format. A custom
// prompt without the format placeholder used to produce unappliable blocks.
import { describe, it, expect, beforeEach } from 'vitest';

let tools, lb;
const ctx = SillyTavern.getContext();

beforeEach(async () => {
    tools = await import('../src/features/feature-tools-engine.js');
    lb = await import('../src/features/feature-lorebook-engine.js');
    ctx.extensionSettings['st_copilot'] = {};
    window.selected_world_info = [];
    window.world_info = { charLore: [] };
});

describe('tools prompt contract', () => {
    it('default prompt keeps the fence example', () => {
        const block = tools.buildToolCallsSystemBlock();
        expect(block).toContain('```tool_call');
    });

    it('custom prompt without format still gets the fence contract', () => {
        ctx.extensionSettings['st_copilot'].toolsSystemPrompt = 'Мой вайб: будь кратким и дружелюбным.';
        const block = tools.buildToolCallsSystemBlock();
        expect(block).toContain('Мой вайб');
        expect(block).toContain('```tool_call');
        expect(block).toContain('emit every tool call ONLY');
    });

    it('custom prompt with the format placeholder — no duplicate contract', () => {
        ctx.extensionSettings['st_copilot'].toolsSystemPrompt = 'Вайб.\n{{tool_call_format}}\nКонец.';
        const block = tools.buildToolCallsSystemBlock();
        expect(block.match(/```tool_call/g) || []).toHaveLength(1);
    });
});

describe('lorebook manage prompt contract', () => {
    it('default prompt keeps the lorebook-changes block', () => {
        const instructions = lb.buildLBAIInstructions({ lorebookAIManageEnabled: true });
        expect(instructions).toContain('```lorebook-changes');
        expect(instructions.match(/```lorebook-changes/g) || []).toHaveLength(1);
    });

    it('custom prompt without {{lorebook_output}} still gets the contract', () => {
        const instructions = lb.buildLBAIInstructions({ lorebookAIManageEnabled: true, lorebookManagePrompt: 'Только вайб, никакого формата.' });
        expect(instructions).toContain('Только вайб');
        expect(instructions).toContain('```lorebook-changes');
        expect(instructions).toContain('output_requirement');
    });

    it('custom prompt with {{lorebook_output}} — no duplicate contract', () => {
        const instructions = lb.buildLBAIInstructions({ lorebookAIManageEnabled: true, lorebookManagePrompt: 'Вайб.\n{{lorebook_output}}' });
        expect(instructions.match(/```lorebook-changes/g) || []).toHaveLength(1);
    });
});
