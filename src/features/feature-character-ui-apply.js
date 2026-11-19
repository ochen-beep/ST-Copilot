import { EXT_DISPLAY } from '../constants.js';
import { getCurrentSession, addMessage } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { applyPatchToField } from '../utils/util-text.js';
import { escHtml } from '../utils/util-dom.js';
import { getCharFieldValue, saveCharacterField } from './feature-character-engine-apply.js';
import { addHistoryToSwipe } from '../ui/ui-chat.js';
import { appendLBHistoryEl } from './feature-lorebook-ui.js';

export async function applyCharChanges(changes, char, afterMsgId = null) {
    if (!char) { toastr.error('[Редактор персонажа] Нет активного персонажа.', EXT_DISPLAY); return; }
    const successLog = [];

    for (const change of changes) {
        const { field, action } = change;
        if (!field) continue;
        try {
            if (field === 'alternate_greetings') {
                const greetings = [...(char.data?.alternate_greetings || [])];
                if (action === 'append') {
                    greetings.push(change.value || '');
                    await saveCharacterField(char, 'alternate_greetings', greetings);
                    successLog.push(change);
                } else {
                    const idx = (change.index || 1) - 1;
                    if (idx < 0 || idx >= greetings.length) { toastr.warning(`[Редактор персонажа] Индекс приветствия ${change.index} вне диапазона.`, EXT_DISPLAY); continue; }

                    if (action === 'overwrite') {
                        greetings[idx] = change.value || '';
                    } else if (action === 'prepend') {
                        greetings[idx] = (change.value || '') + (greetings[idx] ? '\n\n' + greetings[idx] : '');
                    } else if (action === 'append_text') {
                        greetings[idx] = (greetings[idx] ? greetings[idx] + '\n\n' : '') + (change.value || '');
                    } else if (action === 'replace') {
                        let current = greetings[idx];
                        let allMatched = true;
                        for (const patch of (change.patches || [])) {
                            const { result, matched } = applyPatchToField(current, patch);
                            if (!matched) { toastr.warning(`[Редактор персонажа] SEARCH не найдено в приветствии #${change.index}.`, EXT_DISPLAY); allMatched = false; break; }
                            current = result;
                        }
                        if (!allMatched) continue;
                        greetings[idx] = current;
                    }

                    await saveCharacterField(char, 'alternate_greetings', greetings);
                    successLog.push(change);
                }
            } else if (action === 'overwrite') {
                await saveCharacterField(char, field, change.value || '');
                successLog.push(change);
            } else if (action === 'prepend') {
                const current = String(getCharFieldValue(char, field));
                await saveCharacterField(char, field, change.value + (current ? '\n\n' + current : ''));
                successLog.push(change);
            } else if (action === 'append_text') {
                const current = String(getCharFieldValue(char, field));
                await saveCharacterField(char, field, (current ? current + '\n\n' : '') + change.value);
                successLog.push(change);
            } else if (action === 'replace') {
                let current = String(getCharFieldValue(char, field));
                let allMatched = true;
                for (const patch of (change.patches || [])) {
                    const { result, matched } = applyPatchToField(current, patch);
                    if (!matched) { toastr.warning(`[Редактор персонажа] SEARCH не найдено в поле «${field}»: «${escHtml((patch.search || '').slice(0, 60))}…»`, EXT_DISPLAY, { timeOut: 8000 }); allMatched = false; break; }
                    current = result;
                }
                if (!allMatched) continue;
                await saveCharacterField(char, field, current);
                successLog.push(change);
            }
        } catch (e) {
            console.error(`[ST-Copilot-Debug] Failed on char field "${field}":`, e);
            toastr.error(`[Редактор персонажа] Ошибка в поле «${field}»: ${e.message}`, EXT_DISPLAY, { timeOut: 10000 });
        }
    }

    if (successLog.length > 0) {
        logCharEditHistory(successLog, 'Applied', afterMsgId, char.name);
        toastr.success(`[Редактор персонажа] Применено изменений: ${successLog.length} к «${char.name}».`, EXT_DISPLAY);
    }
    _dbgAdd('CHAR_APPLY_DONE', { applied: successLog.length, total: changes.length, char: char.name });
    // UI reconciles card states against this: a field that failed server-side
    // must stay pending instead of being marked applied.
    return successLog;
}

export function logCharEditHistory(changes, statusStr, afterMsgId = null, charName = null) {
    if (!changes?.length) return;
    try {
        const getFieldLabel = (f) => {
            const LBLS = { name:'Name', tags:'Tags', description:'Description', personality:'Personality', scenario:'Scenario', first_mes:'First Message', mes_example:'Example Dialogue', authors_note:"Author's Note", user_persona:"User Persona", alternate_greetings:'Alternate Greetings', system_prompt:'Main Prompt Override', post_history_instructions:'Post-History Instructions' };
            if (LBLS[f]) return LBLS[f];
            if (f && f.startsWith('evolutia_char:')) return `Aspect (Char): ${f.split('evolutia_char:')[1]}`;
            if (f && f.startsWith('evolutia_user:')) return `Aspect (User): ${f.split('evolutia_user:')[1]}`;
            return f || '?';
        };
        const session = getCurrentSession();
        const icon = statusStr === 'Applied' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Applied' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED (ignored)');

        const newLines = changes.map(c => {
            const patches = c.patches ? ` (${c.patches.length} patch${c.patches.length !== 1 ? 'es' : ''})` : '';
            return `${icon} **${actionText}**: \`${getFieldLabel(c.field)}\` — ${c.action || '?'}${c.index ? ` #${c.index}` : ''}${patches}`;
        });

        if (afterMsgId && addHistoryToSwipe(afterMsgId, newLines, charName)) return;

        const histText = `**System Notification** — Character card edits${charName ? ` for **${charName}**` : ''}:\n${newLines.join('\n')}`;
        const msg = addMessage(session, 'system', histText, { isCharEditHistory: true, isLBHistory: true, appliedLines: [...newLines], _charName: charName || null });
        appendLBHistoryEl(msg);
    } catch (_) {}
}

export function logCharCreationHistory(creationData, statusStr, afterMsgId = null) {
    try {
        const session = getCurrentSession();
        const icon = statusStr === 'Applied' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Applied' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED (ignored)');
        const newLines = [`${icon} **${actionText}**: Character Creation Proposal for "${creationData.name_suggestion || 'New Character'}"`];

        if (afterMsgId && addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — Character card edits:\n${newLines.join('\n')}`;
        const msg = addMessage(session, 'system', histText, { isCharEditHistory: true, isLBHistory: true, appliedLines: [...newLines] });
        appendLBHistoryEl(msg);
    } catch (_) {}
}

export function reconstructCharChangesBlock(pendingChanges) {
    if (!pendingChanges.length) return '';
    let xml = '```character-changes\n';
    for (const c of pendingChanges) {
        if (c.action === 'replace') {
            xml += `<replace field="${c.field}"${c.index ? ` index="${c.index}"` : ''}>\n`;
            for (const p of c.patches) {
                xml += `<<<<<<< SEARCH\n${p.search}\n=======\n${p.replace}\n>>>>>>> REPLACE\n`;
            }
            xml += `</replace>\n`;
        } else if (c.action === 'overwrite') {
            xml += `<overwrite field="${c.field}"${c.index ? ` index="${c.index}"` : ''}>${c.value}</overwrite>\n`;
        } else if (c.action === 'append') {
            xml += `<append field="${c.field}">${c.value}</append>\n`;
        } else if (c.action === 'prepend') {
            xml += `<prepend field="${c.field}">${c.value}</prepend>\n`;
        } else if (c.action === 'append_text') {
            xml += `<append_text field="${c.field}">${c.value}</append_text>\n`;
        }
    }
    xml += '```';
    return xml;
}
