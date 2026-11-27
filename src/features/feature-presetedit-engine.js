// Preset editing engine: parse/validate/apply AI proposals for the ACTIVE chat
// completion preset. Lean v1 scope — three ops only:
//   add_variant (content iteration, reversible by toggles), edit (in-place
//   metadata), toggle (switch blocks). Deletion/creation/reorder/gen-fields are
//   deliberately out of scope: deletion is one manual click in the prompt
//   manager, everything else needs placement rules the model shouldn't guess.
//
// The preset is GLOBAL state — every apply is confirmed via proposal cards and
// in-place edits are preceded by a server-side backup preset.

import { PRESET_EDIT_FORMAT_BLOCK, DEFAULT_PRESET_EDIT_DIRECTIVE } from '../constants.js';
import { parseLooseJSON, proposalFenceBodyRegex, proposalStripRegexes } from '../utils/util-text.js';
import { _dbgAdd } from '../utils/util-debug.js';

// prompt_order uses this dummy character id for the global strategy
// (openai.js:697-700 — strategy 'global', dummyId 100001).
const GLOBAL_ORDER_CHARACTER_ID = 100001;
const EDIT_FIELDS = ['name', 'role', 'content', 'injection_position', 'injection_depth', 'injection_order'];
const ROLES = ['system', 'user', 'assistant'];

export function buildPresetEditAIInstructions(settings) {
    if (!settings.presetEditAIEnabled) return '';
    const base = (settings.presetEditPrompt || DEFAULT_PRESET_EDIT_DIRECTIVE.trim())
        .replace('{{preset_edit_format}}', PRESET_EDIT_FORMAT_BLOCK);
    return `<preset_editing>\n${base}\n</preset_editing>`;
}

export function parsePresetChangesFromText(text) {
    const m = text.match(proposalFenceBodyRegex('preset-changes'));
    if (!m || !m[1].trim()) return null;
    const data = parseLooseJSON(m[1].trim());
    if (data && Array.isArray(data.changes)) return _sanitizePresetChanges(data.changes);
    return null;
}

export function stripPresetChangesBlock(text) {
    const { closed, open } = proposalStripRegexes('preset-changes');
    return text.replace(closed, '').replace(open, '').trim();
}

export function _sanitizePresetChanges(changes) {
    if (!Array.isArray(changes)) return null;
    const valid = [];
    for (const c of changes) {
        if (!c || typeof c !== 'object') continue;
        if (c.action === 'add_variant') {
            if (typeof c.target_identifier !== 'string' || !c.target_identifier.trim()) continue;
            if (typeof c.content !== 'string' || !c.content.trim()) continue;
            valid.push({
                action: 'add_variant',
                target_identifier: c.target_identifier.trim(),
                content: c.content,
                role: ROLES.includes(c.role) ? c.role : undefined,
            });
        } else if (c.action === 'edit') {
            if (typeof c.identifier !== 'string' || !c.identifier.trim()) continue;
            const raw = (c.fields && typeof c.fields === 'object') ? c.fields : {};
            const fields = {};
            for (const k of EDIT_FIELDS) if (raw[k] !== undefined) fields[k] = raw[k];
            if (fields.role !== undefined && !ROLES.includes(fields.role)) delete fields.role;
            if (fields.injection_position !== undefined) fields.injection_position = Number(fields.injection_position) === 1 ? 1 : 0;
            if (fields.injection_depth !== undefined) fields.injection_depth = Math.max(0, Math.min(999, parseInt(fields.injection_depth) || 0));
            if (fields.injection_order !== undefined) fields.injection_order = Math.max(0, parseInt(fields.injection_order) || 0);
            if (fields.name !== undefined) fields.name = String(fields.name);
            if (!Object.keys(fields).length) continue;
            valid.push({ action: 'edit', identifier: c.identifier.trim(), fields });
        } else if (c.action === 'toggle') {
            if (typeof c.identifier !== 'string' || !c.identifier.trim()) continue;
            valid.push({ action: 'toggle', identifier: c.identifier.trim(), enabled: c.enabled === undefined ? undefined : !!c.enabled });
        }
    }
    return valid.length ? valid : null;
}

function _getOrderList(oai) {
    let entry = (oai.prompt_order || []).find(o => Number(o.character_id) === GLOBAL_ORDER_CHARACTER_ID);
    if (!entry) {
        entry = { character_id: GLOBAL_ORDER_CHARACTER_ID, order: [] };
        (oai.prompt_order = oai.prompt_order || []).push(entry);
    }
    return entry.order;
}

// saveOpenAIPreset is module-private in ST, but getChatCompletionPreset is
// exported — build the same body and hit the same endpoint ST's own Save
// button uses, so the saved file matches the native format byte-for-byte.
async function _savePresetCopy(oai, name) {
    const mod = await import('/scripts/openai.js');
    const ctx = SillyTavern.getContext();
    const body = mod.getChatCompletionPreset(oai);
    const res = await fetch('/api/presets/save', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name, preset: body }),
    });
    if (!res.ok) throw new Error(`/api/presets/save ${res.status}`);
    return body;
}

async function _saveCurrentPreset(oai) {
    const name = oai.preset_settings_openai;
    // Endpoint write is awaited (deterministic); the native silent Save button
    // runs after it to refresh ST's in-memory per-preset cache the same way the
    // UI's own Update button does.
    await _savePresetCopy(oai, name);
    document.getElementById('update_oai_preset')?.click();
}
export async function applyPresetChanges(changes, presetName) {
    const ctx = SillyTavern.getContext();
    const oai = ctx.chatCompletionSettings;
    if (!oai || !Array.isArray(oai.prompts)) return { error: 'Preset data unavailable.' };
    const currentName = oai.preset_settings_openai;
    if (presetName && presetName !== currentName) {
        return { error: `Preset switched since the proposal (now "${currentName}"). Reject and re-ask.` };
    }
    const order = _getOrderList(oai);
    const applied = [];
    const skipped = [];
    let snapshotName = null;

    if (changes.some(c => c.action === 'edit')) {
        snapshotName = `Backup (pre-copilot) ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
        try {
            await _savePresetCopy(oai, snapshotName);
        } catch (e) {
            return { error: `Snapshot failed, nothing applied: ${e.message}` };
        }
    }

    for (const c of changes) {
        if (c.action === 'add_variant') {
            const target = oai.prompts.find(p => p.identifier === c.target_identifier);
            if (!target || target.marker === true) {
                skipped.push({ action: c.action, target: c.target_identifier, reason: 'target not found or content slot' });
                continue;
            }
            const baseName = target.name || target.identifier;
            const variantCount = oai.prompts.filter(p => typeof p.name === 'string' && p.name.startsWith(`${baseName} • AI `)).length;
            const newName = `${baseName} • AI ${variantCount + 2}`;
            const newId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const newPrompt = { ...structuredClone(target), identifier: newId, name: newName, content: c.content };
            delete newPrompt.marker;
            if (c.role) newPrompt.role = c.role;
            oai.prompts.push(newPrompt);
            const origEntry = order.find(e => e.identifier === target.identifier);
            const idx = origEntry ? order.indexOf(origEntry) : order.length - 1;
            order.splice(idx + 1, 0, { identifier: newId, enabled: true });
            if (origEntry) origEntry.enabled = false;
            if (target.identifier === 'main') oai.system_prompt = c.content;
            applied.push({ action: 'add_variant', target: baseName, name: newName });
        } else if (c.action === 'edit') {
            const target = oai.prompts.find(p => p.identifier === c.identifier);
            if (!target || target.marker === true) {
                skipped.push({ action: 'edit', target: c.identifier, reason: 'target not found or content slot' });
                continue;
            }
            for (const [k, v] of Object.entries(c.fields)) {
                target[k] = v;
            }
            if (c.fields.content !== undefined && c.identifier === 'main') oai.system_prompt = c.fields.content;
            applied.push({ action: 'edit', target: target.name || target.identifier, fields: Object.keys(c.fields) });
        } else if (c.action === 'toggle') {
            const entry = order.find(e => e.identifier === c.identifier);
            if (!entry) {
                skipped.push({ action: 'toggle', target: c.identifier, reason: 'block not in prompt order' });
                continue;
            }
            entry.enabled = c.enabled === undefined ? !entry.enabled : !!c.enabled;
            applied.push({ action: 'toggle', target: c.identifier, enabled: entry.enabled });
        }
    }

    if (applied.length) {
        await _saveCurrentPreset(oai);
        _dbgAdd('PRESET_APPLIED', { applied: applied.length, skipped: skipped.length, snapshot: snapshotName || undefined });
        // Re-render the prompt manager straight from the mutated oai_settings.
        // Do NOT trigger the preset dropdown's change event here: it reloads
        // oai_settings from ST's per-preset cache, which the native button's
        // own async save updates only after a round-trip — the reload raced
        // the cache update and reverted the applied state in memory.
        try {
            const mod = await import('/scripts/openai.js');
            mod.promptManager?.render?.();
        } catch (_) { /* PM unavailable — settings UI just stays stale */ }
    }
    return { applied, skipped, snapshotName };
}
