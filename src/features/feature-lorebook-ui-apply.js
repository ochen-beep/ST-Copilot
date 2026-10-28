// Lorebook UI: proposal apply pipeline + history elements. Split out of
// feature-lorebook-ui.js (now a re-export facade); renderProposalCard and the
// manager overlay live in sibling submodules and import from here directly.
import { EXT_DISPLAY, I } from '../constants.js';
import { getCurrentSession, addMessage, deleteMsg } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { escHtml } from '../utils/util-dom.js';
import { openTextDiffModal } from '../utils/util-diff.js';
import { resolveLBChangeTarget, getActiveLorebookNames, bindNewLorebookToCharacter, wiCache, saveWorldInfoBook } from './feature-lorebook-engine.js';
import { applyPatchToField } from '../utils/util-text.js';
import { updateMsgCount, scrollToBottom, addHistoryToSwipe } from '../ui/ui-chat.js';
import { recordStat, SM } from './feature-stats.js';
export function reconstructLBChangesBlock(pendingChanges) {
    if (!pendingChanges.length) return '';
    return '```lorebook-changes\n{"changes": ' + JSON.stringify(pendingChanges, null, 2) + '}\n```';
}

export function openDiffModal(change, originalEntry) {
    const originalContent = originalEntry?.content || '';
    let newContent = change.content || '';
    
    if (change.action === 'patch' && originalEntry) {
        let current = originalContent;
        for (const patch of (change.patches || [])) {
            const { result } = applyPatchToField(current, patch);
            current = result;
        }
        newContent = current;
    } else if (change.action === 'prepend' && originalEntry) {
        newContent = (change.content || '') + originalContent;
    } else if (change.action === 'append' && originalEntry) {
        newContent = originalContent + (change.content || '');
    }
    
    const entryName = change.name || originalEntry?.comment || `Запись #${change.uid || '?'}`;
    const title = `Сравнение: «${entryName}» в ${change.worldName || '?'}`;
    openTextDiffModal(title, originalContent, newContent);
}

export function renderLBHistoryContent(msg, contentEl) {
    contentEl.innerHTML = '';
    const lines = msg.appliedLines || [];
    const accepted = lines.filter(l => l.includes('ACCEPTED')).length;
    const rejected = lines.filter(l => l.includes('REJECTED')).length;
    const dismissed = lines.filter(l => l.includes('DISMISSED')).length;

    const summaryParts = [];
    if (accepted) summaryParts.push(`${accepted} применено`);
    if (rejected) summaryParts.push(`${rejected} отклонено`);
    if (dismissed) summaryParts.push(`${dismissed} отклонено`);
    const summaryStr = summaryParts.length ? summaryParts.join(', ') : `${lines.length} ${lines.length !== 1 ? 'изменений' : 'изменение'}`;

    const summaryRow = document.createElement('div');
    summaryRow.style.cssText = 'font-size:12px;font-weight:600;color:var(--scp-text);margin-bottom:4px';
    summaryRow.textContent = `Системное уведомление: ${summaryStr}`;
    contentEl.appendChild(summaryRow);

    if (lines.length) {
        const details = document.createElement('details');
        details.className = 'scp-hist-details';
        const summary = document.createElement('summary');
        summary.className = 'scp-hist-summary';
        summary.textContent = 'Показать подробности';
        details.appendChild(summary);

        const detailsBody = document.createElement('div');
        detailsBody.className = 'scp-hist-body';
        for (const line of lines) {
            const stripped = line.replace(/\*\*/g, '').replace(/`/g, '');
            const isAccepted = stripped.includes('ACCEPTED');
            const isRejected = stripped.includes('REJECTED') && !stripped.includes('DISMISSED');
            const dot = document.createElement('div');
            dot.className = 'scp-hist-item';
            dot.style.cssText = `display:flex;align-items:baseline;gap:6px;padding:2px 0;font-size:11px;color:${isAccepted ? 'var(--scp-success)' : isRejected ? 'var(--scp-danger)' : 'var(--scp-text-muted)'}`;
            const marker = document.createElement('span');
            marker.style.cssText = `width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0;margin-top:5px;display:inline-block`;
            const text = document.createElement('span');
            const m2 = stripped.match(/(?:ACCEPTED|REJECTED|DISMISSED[^:]*): (.+)/);
            text.textContent = m2 ? m2[1] : stripped;
            dot.appendChild(marker);
            dot.appendChild(text);
            detailsBody.appendChild(dot);
        }
        details.appendChild(detailsBody);
        contentEl.appendChild(details);
    }
}

export function appendLBHistoryEl(msg, afterMsgId = null) {
    const c = document.getElementById('scp-messages');
    if (!c) return;
    c.querySelector('.scp-empty-state')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'scp-msg scp-msg-lb-history';
    wrap.dataset.id = msg.id;

    const avatar = document.createElement('div');
    avatar.className = 'scp-msg-avatar scp-msg-avatar-lb';
    
    if (msg.isCharEditHistory) {
        avatar.innerHTML = '<i class="fa-solid fa-user-pen" style="font-size:14px; padding-left:1px;"></i>';
    } else if (msg.isChatEditHistory) {
        avatar.innerHTML = '<i class="fa-solid fa-comments" style="font-size:14px; padding-left:1px;"></i>';
    } else {
        avatar.innerHTML = I.book;
    }

    const body = document.createElement('div');
    body.className = 'scp-msg-body';

    const contentEl = document.createElement('div');
    contentEl.className = 'scp-msg-content scp-lb-history-content';
    renderLBHistoryContent(msg, contentEl);

    const meta = document.createElement('div');
    meta.className = 'scp-msg-meta';
    meta.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'scp-msg-btn scp-lb-history-close';
    closeBtn.innerHTML = I.x;
    closeBtn.title = 'Скрыть уведомление';
    closeBtn.addEventListener('click', () => {
        const session = getCurrentSession();
        deleteMsg(session, msg.id);
        wrap.remove();
        updateMsgCount(session);
    });

    body.appendChild(contentEl);
    body.appendChild(closeBtn);
    body.appendChild(meta);
    wrap.appendChild(avatar); wrap.appendChild(body);
    
    const anchor = afterMsgId
        ? (c.querySelector(`.scp-lb-proposal-card[data-for="${afterMsgId}"]`) || c.querySelector(`.scp-msg[data-id="${afterMsgId}"]`))
        : null;
    if (anchor) anchor.after(wrap);
    else c.appendChild(wrap);
    updateMsgCount(getCurrentSession());
    if (!anchor) scrollToBottom();
}

export function logLBHistoryChanges(changes, statusStr, afterMsgId = null) {
    if (!changes || !changes.length) return;
    try {
        const session = getCurrentSession();
        const icons = { add: '✚', edit: '✎', patch: '✂', delete: '✕' };
        const statusIcon = statusStr === 'Accepted' ? '✓' : (statusStr === 'Rejected' ? '✕' : '·');
        const actionText = statusStr === 'Accepted' ? 'ACCEPTED' : (statusStr === 'Rejected' ? 'REJECTED' : 'DISMISSED (ignored)');

        const newLines = changes.map(c => {
            const act = (c.action || 'edit').toUpperCase();
            return `${statusIcon} **${actionText}**: ${icons[c.action] || '·'} ${act} "${c.name || c.originalName || `Entry #${c.uid || '?'}`}" in \`${c.worldName || '?'}\``;
        });

        if (afterMsgId && addHistoryToSwipe(afterMsgId, newLines)) return;

        const histText = `**System Notification** — User interaction with proposed lorebook changes:\n${newLines.join('\n')}`;
        const histMsg = addMessage(session, 'system', histText, { isLBHistory: true, appliedLines: [...newLines] });
        appendLBHistoryEl(histMsg);
    } catch (_) {}
}

// Serialized: two concurrent applies clone the same base book (per-item buttons
// vs Apply-all) and the last save silently drops the other call's edits.
let _lbApplyQueue = Promise.resolve();

export function applyLBChanges(changes, afterMsgId = null) {
    const tail = _lbApplyQueue.then(() => _applyLBChangesInner(changes, afterMsgId));
    _lbApplyQueue = tail.catch(() => {});
    return tail;
}

async function _applyLBChangesInner(changes, afterMsgId = null) {
    console.log(`[${EXT_DISPLAY}] applyLBChanges: processing ${changes.length} change(s)`, JSON.parse(JSON.stringify(changes)));
    const bookCache = {};      // bookName -> рабочая копия книги (клонируется при первом касании)
    const origBooks = {};      // bookName -> исходный объект из wiCache (для отката при сбое сейва)
    const successfulChanges =[];

    for (const change of changes) {
        let { bookName, data, origEntry } = await resolveLBChangeTarget(change);

        if (change.worldName && change.action !== 'delete') {
            const activeBooks = getActiveLorebookNames();
            
            if (!activeBooks.includes(change.worldName)) {
                await bindNewLorebookToCharacter(change.worldName);
                
                const resolved = await resolveLBChangeTarget(change);
                bookName = resolved.bookName;
                data = resolved.data;
                origEntry = resolved.origEntry;
            }
        }

        if (!data) {
            const msg = `Лорбук не найден: «${change.worldName || '(пусто)'}» — активен ли он в этом чате?`;
            toastr.error(`[ЛБ] ${msg}`, EXT_DISPLAY, { timeOut: 10000 });
            console.error(`[${EXT_DISPLAY}] applyLBChanges: ${msg}`, change);
            continue;
        }
        if (!bookName) {
            toastr.error(`[ЛБ] Не удалось определить имя книги для изменения: «${change.name || change.uid || '?'}»`, EXT_DISPLAY, { timeOut: 10000 });
            continue;
        }

        // Работаем с клоном книги: неуспешный сейв не должен оставлять живой
        // кэш мутированным относительно диска. wiCache подменяем на рабочую
        // копию, чтобы последующие resolveLBChangeTarget в этом же вызове
        // видели уже применённые изменения.
        if (!bookCache[bookName]) {
            bookCache[bookName] = structuredClone(data);
            origBooks[bookName] = data;
            wiCache[bookName] = bookCache[bookName];
        }
        data = bookCache[bookName];
        if (origEntry && data.entries[origEntry.uid]) origEntry = data.entries[origEntry.uid];
        change._resolvedBook = bookName;

        if (change.action === 'add' && data) {
            const exists = Object.values(data.entries).find(e => e.comment && e.comment.toLowerCase() === (change.name || '').toLowerCase());
            if (exists) {
                _dbgAdd('LB_ADD_CONVERTED_TO_EDIT', { bookName, change, originalUid: exists.uid });
                change.action = 'edit';
                change.uid = exists.uid;
                origEntry = exists;
            }
        }

        if (change.action === 'add') {
            const uids = Object.keys(data.entries).map(Number);
            const newUid = uids.length ? Math.max(...uids) + 1 : 1;
            const isOutlet = !!(change.outlet || change.outlet_name);
            const outletName = (change.outlet_name || '').trim();
            const addTriggers = isOutlet ? [] : (Array.isArray(change.triggers) ? change.triggers : []);
            const autoConstant = !isOutlet && (addTriggers.length === 0) && change.constant !== false;
            data.entries[newUid] = {
                uid: newUid,
                key: addTriggers,
                keysecondary: [],
                content: change.content || '',
                comment: change.name || '',
                disable: false,
                selective: false,
                constant: !isOutlet && (change.constant === true || autoConstant),
                position: isOutlet ? 7 : (change.position ?? 0),
                displayIndex: newUid,
                automation_id: outletName,
                outletName: outletName,
                group: change.group || (isOutlet ? outletName : ''),
                role: null,
                extensions: {
                    outlet_name: outletName
                }
            };
            successfulChanges.push(change);
        } else if (change.action === 'edit') {
            if (!origEntry) {
                toastr.error(`[ЛБ] Запись для редактирования не найдена: «${change.name || change.uid || '?'}» в «${bookName}»`, EXT_DISPLAY, { timeOut: 10000 });
                continue;
            }
            if (change.name !== undefined) origEntry.comment = change.name;
            if (change.triggers !== null && change.triggers !== undefined) {
                origEntry.key = change.triggers;
                if (change.triggers.length === 0 && origEntry.key.length === 0 && change.constant !== false) origEntry.constant = true;
            }
            if (change.content !== undefined) origEntry.content = change.content;
            if (change.constant !== undefined) origEntry.constant = !!change.constant;
            if (change.outlet !== undefined || change.outlet_name !== undefined) {
                const oName = (change.outlet_name || '').trim();
                if (!origEntry.extensions) origEntry.extensions = {};
                if (change.outlet || oName) {
                    origEntry.position = 7;
                    origEntry.automation_id = oName;
                    origEntry.outletName = oName;
                    origEntry.group = oName;
                    origEntry.constant = false;
                    origEntry.extensions.outlet_name = oName;
                } else {
                    origEntry.position = change.position ?? 0;
                    origEntry.automation_id = '';
                    origEntry.outletName = '';
                    origEntry.group = '';
                    origEntry.extensions.outlet_name = '';
                }
            }
            successfulChanges.push(change);
        } else if (change.action === 'patch') {
            if (!origEntry) {
                toastr.error(`[ЛБ] Запись для исправления не найдена: «${change.name || change.uid || '?'}» в «${bookName}»`, EXT_DISPLAY, { timeOut: 10000 });
                continue;
            }
            let current = origEntry.content || '';
            let allMatched = true;
            for (const patch of (change.patches || [])) {
                const { result, matched } = applyPatchToField(current, patch);
                if (!matched) {
                    toastr.warning(`[ЛБ] SEARCH не найдено в «${escHtml(origEntry.comment)}»: «${escHtml((patch.search || '').slice(0, 60))}»`, EXT_DISPLAY, { timeOut: 8000 });
                    allMatched = false;
                    break;
                }
                current = result;
            }
            if (!allMatched) continue;
            origEntry.content = current;
            if (change.name !== undefined) origEntry.comment = change.name;
            if (change.triggers !== null && change.triggers !== undefined) {
                origEntry.key = change.triggers;
                if (change.triggers.length === 0 && change.constant !== false) origEntry.constant = true;
            }
            if (change.constant !== undefined) origEntry.constant = !!change.constant;
            successfulChanges.push(change);
        } else if (change.action === 'prepend' || change.action === 'append') {
            if (!origEntry) continue;
            let current = origEntry.content || '';
            origEntry.content = change.action === 'prepend' ? (change.content || '') + current : current + (change.content || '');
            if (change.name !== undefined) origEntry.comment = change.name;
            if (change.triggers !== null && change.triggers !== undefined) {
                origEntry.key = change.triggers;
                if (change.triggers.length === 0 && change.constant !== false) origEntry.constant = true;
            }
            if (change.constant !== undefined) origEntry.constant = !!change.constant;
            successfulChanges.push(change);
        } else if (change.action === 'delete') {
            if (!origEntry) continue;
            delete data.entries[origEntry.uid];
            successfulChanges.push(change);
        }
    }

    if (changes.length > 0 && !Object.keys(bookCache).length) {
        toastr.warning('[ЛБ] Изменения не применены — подробности см. в консоли браузера (F12)', EXT_DISPLAY, { timeOut: 10000 });
        return [];
    }

    // Сохраняем по книгам и честно считаем применённым только то, что реально
    // ушло на диск: при сбое сейва кэш откатывается к исходному объекту,
    // а изменения этой книги не попадают в успешные.
    const failedBooks = new Set();
    for (const [name, data] of Object.entries(bookCache)) {
        try {
            await saveWorldInfoBook(name, data);
        } catch (e) {
            failedBooks.add(name);
            wiCache[name] = origBooks[name];
            toastr.error(`[ЛБ] Ошибка сохранения для «${name}»: ${e.message}`, EXT_DISPLAY, { timeOut: 12000 });
        }
    }

    const applied = failedBooks.size
        ? successfulChanges.filter(c => !failedBooks.has(c._resolvedBook))
        : successfulChanges;
    for (const c of successfulChanges) delete c._resolvedBook;

    if (applied.length > 0) {
        recordStat(SM.lb, applied.length);
        logLBHistoryChanges(applied, 'Accepted', afterMsgId);
    }
    return applied;
}
