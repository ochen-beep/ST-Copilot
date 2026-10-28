import { EXT_DISPLAY, CHAT_EDIT_FORMAT_BLOCK, DEFAULT_CHAT_EDIT_DIRECTIVE } from '../constants.js';
import { getCurrentSession, addMessage } from '../session.js';
import { applyPatchToField, _repairJSON } from '../utils/util-text.js';
import { escHtml } from '../utils/util-dom.js';

export function buildChatEditAIInstructions(settings) {
    if (!settings.chatEditAIEnabled) return '';
    const ctx = SillyTavern.getContext();
    const stMsgs = ctx.chat || [];
    const chatDisplayName = ctx.chatMetadata?.name || (typeof window.chat_file_name === 'string' ? window.chat_file_name : '') || 'unknown';
    const depth = Math.max(0, parseInt(settings.contextDepth) || 0);
    let slice;
    try {
        const sess = getCurrentSession();
        const picked = sess.pickedChatIndices;
        if (picked && picked.length > 0) {
            slice = picked.filter(i => i >= 0 && i < stMsgs.length);
        } else {
            slice = depth > 0 ? stMsgs.slice(-depth).map((_, i) => stMsgs.length - depth + i) : [];
        }
    } catch(_) {
        slice = depth > 0 ? stMsgs.slice(-depth).map((_, i) => stMsgs.length - depth + i) : [];
    }
    const activeChatIds = slice.map(i => `#${i}`).join(', ') || 'none';
    const base = (settings.chatEditPrompt || DEFAULT_CHAT_EDIT_DIRECTIVE.trim())
        .replace('{{chat_edit_format}}', CHAT_EDIT_FORMAT_BLOCK)
        .replace('{{active_chat_ids}}', activeChatIds);
    const chatNameNote = `\nCurrent chat name: "${chatDisplayName}"`;
    return `<chat_messages_editing>\n${base}${chatNameNote}\n</chat_messages_editing>`;
}

export function parseChatChangesFromText(text) {
    let raw = null;
    const strict = text.match(/```chat-changes\s*([\s\S]*?)```/);
    if (strict) { raw = strict[1].trim(); }
    else {
        const open = text.match(/```chat-changes\s*([\s\S]*?)(?=```|$)/);
        if (open) raw = open[1].trim();
    }
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.changes)) return _sanitizeChatChanges(data.changes);
    } catch (_) {}
    try {
        const data = JSON.parse(_repairJSON(raw));
        if (Array.isArray(data.changes)) return _sanitizeChatChanges(data.changes);
    } catch (_) {}
    return null;
}

export function _sanitizeChatChanges(changes) {
    if (!Array.isArray(changes)) return null;
    const valid = [];
    for (const c of changes) {
        if (!c || typeof c !== 'object') continue;
        if (!['replace', 'overwrite', 'prepend', 'append', 'bulk_replace', 'regex', 'delete', 'add', 'hide', 'unhide', 'rename_chat'].includes(c.action)) continue;

        if (c.action === 'rename_chat') {
            if (!c.name?.trim()) continue;
            valid.push(c);
            continue;
        }

        if (c.msg_indices !== undefined) {
            if (typeof c.msg_indices === 'string') {
                c.msg_indices = c.msg_indices.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            }
            if (!Array.isArray(c.msg_indices) || !c.msg_indices.length) delete c.msg_indices;
            else c.msg_indices = [...new Set(c.msg_indices)].sort((a, b) => a - b);
        }

        if (c.action === 'add') {
            if (!c.role) c.role = 'assistant';
            if (c.msg_index === undefined) c.msg_index = 99999;
        } else if (c.action === 'bulk_replace' || c.action === 'hide' || c.action === 'unhide') {
            if (c.action === 'bulk_replace' && (!Array.isArray(c.replacements) || (!Array.isArray(c.msg_range) && !Array.isArray(c.msg_indices)))) continue;
            if (c.action === 'bulk_replace') {
                c.replacements = c.replacements.map(r => {
                    if (typeof r === 'object') {
                        r.search = r.search || r.anchor;
                        if (r.search !== undefined) return r;
                    }
                    return null;
                }).filter(Boolean);
            }
        } else {
            if (c.msg_index === undefined && c.msg_id === undefined && c.msg_range === undefined && !c.msg_indices) continue;
        }
        if (c.action === 'replace' && Array.isArray(c.patches)) {
            c.patches = c.patches.map(p => {
                if (typeof p === 'object') {
                    p.search = p.search || p.anchor;
                    if (p.search !== undefined) return p;
                }
                return null;
            }).filter(Boolean);
        }
        valid.push(c);
    }
    return valid.length ? valid : null;
}

export function stripChatChangesBlock(text) {
    return text.replace(/```chat-changes[\s\S]*?```/g, '').replace(/```chat-changes[\s\S]*/g, '').trim();
}

export function reconstructChatChangesBlock(pendingChanges) {
    if (!pendingChanges.length) return '';
    return '```chat-changes\n{"changes": ' + JSON.stringify(pendingChanges, null, 2) + '}\n```';
}

export function _resolveStMsgByIndexOrId(change) {
    const ctx = SillyTavern.getContext();
    const msgs = ctx.chat || [];
    if (typeof change.msg_index === 'number') {
        if (change.msg_index >= 0 && change.msg_index < msgs.length) {
            return { idx: change.msg_index, msg: msgs[change.msg_index] };
        }
    }
    return null;
}

// Событие об обновлении сообщения — на каждое изменение, а вот само сохранение
// чата (сериализация всего чата на диск) — один раз в конце applyChatChanges:
// раньше bulk-правка из N сообщений делала N полных saveChat подряд.
export async function _saveChatMessage(ctx, idx, msg) {
    try {
        const es = ctx.eventSource || window.eventSource;
        const et = ctx.event_types || window.event_types;
        if (es && et?.MESSAGE_UPDATED) {
            es.emit(et.MESSAGE_UPDATED, idx);
        }
    } catch(e) { console.warn('[ChatEdit] Event error:', e); }
}

export async function _saveChatAfterDelete(ctx) {
    // намеренно пусто: сохранение централизовано в конце applyChatChanges
}

async function _persistChat(ctx) {
    try {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        else if (typeof window.saveChat === 'function') await window.saveChat();
    } catch(e) { console.warn('[ChatEdit] Save error:', e); }
}

export function _refreshSTChatDOM(ctx) {
    try {
        const es = ctx.eventSource || window.eventSource;
        const et = ctx.event_types || window.event_types;
        if (es && et?.CHAT_CHANGED) es.emit(et.CHAT_CHANGED);
        if (typeof window.printMessages === 'function') window.printMessages();
        else if (typeof ctx.printMessages === 'function') ctx.printMessages();
    } catch(_) {}
}

export async function logChatEditHistory(changes, statusStr, afterMsgId = null) {
    if (!changes?.length) return;
    try {
        const session = getCurrentSession();
        const icon = statusStr === 'Applied' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Applied' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED');
        
        const newLines = changes.map(c => {
            let target = `\`#${escHtml(c.msg_index ?? c.msg_id ?? '?')}\``;
            if (c.msg_range && Array.isArray(c.msg_range)) target = `[${c.msg_range[0]}–${c.msg_range[1]}]`;
            if (Array.isArray(c.msg_indices) && c.msg_indices.length) target = `[${c.msg_indices.join(', ')}]`;
            let extras = c.affectedCount !== undefined ? ` (${c.affectedCount} affected)` : '';
            return `${icon} **${actionText}**: \`${escHtml(c.action)}\` on message ${target}${extras}`;
        });
        
        const uiChatMod = await import('../ui/ui-chat.js');
        if (afterMsgId && uiChatMod.addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — Chat message edits:\n${newLines.join('\n')}`;
        const msg = addMessage(session, 'system', histText, { isChatEditHistory: true, isLBHistory: true, appliedLines: [...newLines] });
        
        const lbUiMod = await import('./feature-lorebook-ui.js');
        if (lbUiMod.appendLBHistoryEl) {
            lbUiMod.appendLBHistoryEl(msg);
        }
    } catch(_) {}
}

export async function applyChatChanges(changes, afterMsgId = null) {
    const ctx = SillyTavern.getContext();
    const msgs = ctx.chat;
    if (!msgs) { toastr.error('[Редактор чата] Нет активного чата.', EXT_DISPLAY); return; }
    const successLog = [];
    // Changes carry indices from the pre-mutation snapshot the model saw, but
    // deletes/inserts earlier in the batch shift live positions. indexDelta
    // converts an original index to its live position at each step.
    let indexDelta = 0;
    const shifted = (i) => (typeof i === 'number' ? i + indexDelta : i);

    for (const change of changes) {
        try {
            if (change.action === 'rename_chat') {
                const newName = change.name.trim();
                const ctx2 = SillyTavern.getContext();
                const oldFileName = window.chat_file_name;
                
                try {
                    if (typeof ctx2.executeSlashCommandsWithOptions === 'function') {
                        // STscript treats top-level | as a command separator and
                        // {{...}} as macros — a model-supplied name must not
                        // carry either past /renamechat.
                        const safeName = newName.replace(/[|{}]/g, ' ').replace(/[\r\n]/g, ' ');
                        await ctx2.executeSlashCommandsWithOptions(`/renamechat ${safeName}`);
                    }
                    
                    if (window.chat_file_name && window.chat_file_name !== oldFileName) {
                        const sess = getCurrentSession();
                        if (sess && sess.stChatId === oldFileName) {
                            sess.stChatId = window.chat_file_name;
                        }
                    }
                    
                    if (ctx2.chatMetadata) {
                        ctx2.chatMetadata.name = newName;
                    }
                    successLog.push(change);
                } catch(e) {
                    console.error('[ChatEdit] Error renaming chat', e);
                }
                continue;
            }
            if (change.action === 'hide' || change.action === 'unhide') {
                const cmd = change.action === 'hide' ? '/hide' : '/unhide';
                if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                    const valid = change.msg_indices.map(shifted).filter(i => i >= 0 && i < msgs.length);
                    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
                        for (const idx of valid) {
                            await ctx.executeSlashCommandsWithOptions(`${cmd} ${idx}-${idx}`);
                        }
                    }
                    successLog.push(Object.assign(change, { affectedCount: valid.length }));
                } else {
                    let startIdx = 0, endIdx = msgs.length - 1;
                    if (Array.isArray(change.msg_range)) {
                        // Range values can reach a slash command — coerce to
                        // integers (raw model strings could carry STscript separators).
                        startIdx = parseInt(shifted(change.msg_range[0]));
                        endIdx = parseInt(shifted(change.msg_range[1]));
                        if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) continue;
                    } else if (change.msg_index !== undefined) {
                        startIdx = shifted(parseInt(change.msg_index)); endIdx = startIdx;
                    }
                    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
                        await ctx.executeSlashCommandsWithOptions(`${cmd} ${startIdx}-${endIdx}`);
                    }
                    successLog.push(Object.assign(change, { affectedCount: endIdx - startIdx + 1 }));
                }
                continue;
            }

            if (change.action === 'add') {
                const isSys = change.role === 'system';
                const isUser = change.role === 'user';
                const newMsg = {
                    name: isSys ? 'System' : (isUser ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')),
                    is_user: isUser,
                    is_system: isSys,
                    send_date: Date.now(),
                    mes: change.content || '',
                    extra: {}
                };
                let insertIdx = msgs.length;
                if (typeof change.msg_index === 'number' && change.msg_index >= 0) {
                    insertIdx = Math.min(shifted(change.msg_index), msgs.length);
                }
                const appended = insertIdx >= msgs.length;
                msgs.splice(insertIdx, 0, newMsg);
                if (!appended) indexDelta += 1; // originals at/after the insert shift down
                await _saveChatAfterDelete(ctx);
                successLog.push(change);
                continue;
            }

            if (change.action === 'bulk_replace' || change.action === 'regex') {
                let targetIndices = [];
                if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                    targetIndices = change.msg_indices.map(shifted).filter(i => i >= 0 && i < msgs.length);
                } else {
                    let startIdx = 0, endIdx = msgs.length - 1;
                    if (Array.isArray(change.msg_range)) {
                        // Range values can reach a slash command — coerce to
                        // integers (raw model strings could carry STscript separators).
                        startIdx = parseInt(shifted(change.msg_range[0]));
                        endIdx = parseInt(shifted(change.msg_range[1]));
                        if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) continue;
                    } else if (change.msg_index !== undefined) {
                        startIdx = shifted(parseInt(change.msg_index)); endIdx = startIdx;
                    }
                    for (let i = Math.max(0, startIdx); i <= Math.min(msgs.length - 1, endIdx); i++) targetIndices.push(i);
                }

                let affected = 0;
                for (const i of targetIndices) {
                    const msg = msgs[i];
                    let content = msg.mes || '';
                    let changed = false;

                    if (change.action === 'bulk_replace') {
                        for (const rp of (change.replacements || [])) {
                            if (!rp.search && !rp.anchor) continue;
                            const { result, matched } = applyPatchToField(content, rp);
                            if (matched) { content = result; changed = true; }
                        }
                    } else if (change.action === 'regex') {
                        try {
                            const m = (change.regex || '').match(/^\/([\s\S]+)\/([a-z]*)$/i);
                            const re = m ? new RegExp(m[1], m[2]) : new RegExp(change.regex, 'g');
                            if (re.test(content)) {
                                content = content.replace(re, change.replace || '');
                                changed = true;
                            }
                        } catch(e) { toastr.error(`[Редактор чата] Неверное регулярное выражение: ${change.regex}`, EXT_DISPLAY); }
                    }

                    if (changed) {
                        msg.mes = content;
                        await _saveChatMessage(ctx, i, msg);
                        affected++;
                    }
                }
                successLog.push(Object.assign(change, { affectedCount: affected }));
                continue;
            }

            if (Array.isArray(change.msg_indices) && change.msg_indices.length) {
                let allSuccess = true;
                const sortedIndices = [...change.msg_indices].map(shifted).sort((a, b) =>
                    change.action === 'delete' ? b - a : a - b
                );
                let deletedCount = 0;
                for (const idx of sortedIndices) {
                    if (idx < 0 || idx >= msgs.length) {
                        toastr.warning(`[Редактор чата] Сообщение #${idx} не найдено`, EXT_DISPLAY, { timeOut: 6000 });
                        allSuccess = false; continue;
                    }
                    const msg = msgs[idx];
                    if (change.action === 'delete') {
                        msgs.splice(idx, 1);
                        deletedCount++;
                        await _saveChatAfterDelete(ctx);
                        continue;
                    }
                    let content = msg.mes || '';
                    if (change.action === 'overwrite') {
                        content = change.content || '';
                    } else if (change.action === 'prepend') {
                        content = (change.content || '') + content;
                    } else if (change.action === 'append') {
                        content = content + (change.content || '');
                    } else if (change.action === 'replace') {
                        let matched = true;
                        for (const patch of (change.patches || [])) {
                            const { result, matched: m } = applyPatchToField(content, patch);
                            if (!m) { toastr.warning(`[Редактор чата] ANCHOR не найден в #${idx}: «${escHtml((patch.search || patch.anchor || '').slice(0, 60))}»`, EXT_DISPLAY, { timeOut: 8000 }); matched = false; break; }
                            content = result;
                        }
                        if (!matched) { allSuccess = false; continue; }
                    }
                    msg.mes = content;
                    await _saveChatMessage(ctx, idx, msg);
                }
                if (change.action === 'delete') indexDelta -= deletedCount;
                if (allSuccess) successLog.push(change);
                continue;
            }

            if (typeof change.msg_index === 'number') {
                // Resolve against the live position of the original index.
                change.msg_index += indexDelta;
            }
            const resolved = _resolveStMsgByIndexOrId(change);
            if (!resolved) {
                toastr.warning(`[Редактор чата] Сообщение не найдено: Индекс ${change.msg_index ?? change.msg_id}`, EXT_DISPLAY, { timeOut: 6000 });
                continue;
            }
            const { idx, msg } = resolved;

            if (change.action === 'delete') {
                // Splice only: ctx.deleteMessage() splices ctx.chat again, which
                // removes the message that shifted into idx (same contract as the
                // msg_indices path). DOM + disk are handled by _refreshSTChatDOM
                // and _persistChat after the batch loop.
                msgs.splice(idx, 1);
                indexDelta -= 1;
                await _saveChatAfterDelete(ctx);
                successLog.push(change);
                continue;
            }

            let content = msg.mes || '';
            if (change.action === 'overwrite') {
                content = change.content || '';
            } else if (change.action === 'prepend') {
                content = (change.content || '') + content;
            } else if (change.action === 'append') {
                content = content + (change.content || '');
            } else if (change.action === 'replace') {
                let allMatched = true;
                for (const patch of (change.patches || [])) {
                    const { result, matched } = applyPatchToField(content, patch);
                    if (!matched) {
                        toastr.warning(`[Редактор чата] ANCHOR не найден в сообщении ${change.msg_index ?? change.msg_id}: «${escHtml((patch.search || patch.anchor || '').slice(0, 60))}»`, EXT_DISPLAY, { timeOut: 8000 });
                        allMatched = false; break;
                    }
                    content = result;
                }
                if (!allMatched) continue;
            }
            msg.mes = content;
            await _saveChatMessage(ctx, idx, msg);
            successLog.push(change);
        } catch (e) {
            console.error(`[ST-Copilot-Debug] ChatEdit Failed:`, e);
            toastr.error(`[Редактор чата] Ошибка изменения: ${e.message}`, EXT_DISPLAY, { timeOut: 10000 });
        }
    }

    if (successLog.length > 0) {
        await _persistChat(ctx);
        setTimeout(() => _refreshSTChatDOM(ctx), 100);
        await logChatEditHistory(successLog, 'Applied', afterMsgId);
        toastr.success(`[Редактор чата] Применено изменений: ${successLog.length}.`, EXT_DISPLAY);
    }
    // Возвращаем фактически применённые изменения: UI сверяется с ними,
    // чтобы не помечать «применено» правки, у которых не совпал якорь.
    return successLog;
}