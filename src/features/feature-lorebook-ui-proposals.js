// Lorebook UI: the interactive proposal card rendered under an assistant
// message (per-item apply/reject, world dropdown, edit panel). Split out of
// feature-lorebook-ui.js; apply/history helpers are imported from the sibling
// apply submodule directly, not through the facade.
import { EXT_DISPLAY, I } from '../constants.js';
import { getCurrentSession, saveSessionsToMetadata } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { escHtml, showCustomDialog } from '../utils/util-dom.js';
import { stripLBChangesBlock, getActiveLorebookNames, getDisplayName, resolveLBChangeTarget } from './feature-lorebook-engine.js';
import { applyPatchToField } from '../utils/util-text.js';
import { bringWindowToFront } from '../ui/ui-window.js';
import { reconstructLBChangesBlock, openDiffModal, applyLBChanges, logLBHistoryChanges } from './feature-lorebook-ui-apply.js';
export function renderProposalCard(changes, msgEl) {
    if (!changes?.length) return;
    _dbgAdd('LB_PROPOSAL_CARD_RENDER', { msgId: msgEl.dataset.id, changesCount: changes.length });

    document.querySelector(`.scp-lb-proposal-card[data-for="${msgEl.dataset.id}"]`)?.remove();

    const editableChanges = changes.map(c => ({ ...c }));
    const itemStates = editableChanges.map(() => 'pending');
    const actionLabels = { add: '+ Добавить', edit: '✎ Изменить', patch: '✂ Исправить', prepend: '⬆ В начало', append: '⬇ В конец', delete: '✕ Удалить' };

    const card = document.createElement('div');
    card.className = 'scp-lb-proposal-card';
    card.dataset.for = msgEl.dataset.id;
    card.style.margin = '8px 0 0 0';

    const syncBlockToMessage = () => {
        const session = getCurrentSession();
        const msg = session.messages.find(m => m.id === card.dataset.for);
        if (!msg) return;
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        const stripped = stripLBChangesBlock(msg.content);
        if (pending.length === 0) {
            msg.content = stripped;
        } else {
            msg.content = stripped + '\n\n' + reconstructLBChangesBlock(pending);
        }
        if (msg.swipes) msg.swipes[msg.swipeIndex || 0].content = msg.content;
        saveSessionsToMetadata();
    };

    const getPendingCount = () => itemStates.filter(s => s === 'pending').length;
    const getAppliedCount = () => itemStates.filter(s => s === 'applied').length;
    const checkAllResolved = () => { if (getPendingCount() === 0) { syncBlockToMessage(); card.remove(); } };

    const header = document.createElement('div');
    header.className = 'scp-lb-proposal-header';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0';
    headerLeft.innerHTML = `<span class="scp-lb-proposal-icon">${I.book}</span><span class="scp-lb-proposal-title">Предложенные изменения лорбука</span>`;

    const countBadge = document.createElement('span');
    countBadge.className = 'scp-lb-proposal-count';
    countBadge.textContent = `${editableChanges.length} ожидает`;
    headerLeft.appendChild(countBadge);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'scp-lb-proposal-dismiss';
    dismissBtn.innerHTML = I.x; dismissBtn.title = 'Отклонить';
    dismissBtn.addEventListener('click', () => {
        const dismissedChanges = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        _dbgAdd('LB_PROPOSAL_ACTION', { action: 'dismissed', msgId: card.dataset.for, dismissedCount: dismissedChanges.length });
        if (dismissedChanges.length > 0) logLBHistoryChanges(dismissedChanges, 'Dismissed', card.dataset.for);
        itemStates.forEach((s, i) => { if (s === 'pending') itemStates[i] = 'dismissed'; });
        syncBlockToMessage(); card.remove();
    });

    header.appendChild(headerLeft); header.appendChild(dismissBtn);

    const list = document.createElement('div');
    list.className = 'scp-lb-proposal-list';
    const itemEls = [];

    editableChanges.forEach((c, ci) => {
        const item = document.createElement('div');
        item.className = `scp-lb-proposal-item scp-lb-proposal-${c.action || 'edit'}`;

        const itemHeader = document.createElement('div');
        itemHeader.className = 'scp-lb-proposal-item-header';

        const itemMeta = document.createElement('div');
        itemMeta.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap';
        itemMeta.innerHTML = `<span class="scp-lb-proposal-action">${escHtml(actionLabels[c.action] || c.action || '?')}</span><span class="scp-lb-proposal-name scp-lb-pn-target">${escHtml(c.name || c.originalName || `Запись #${c.uid || '?'}`)}</span>${c.constant ? '<span class="scp-lb-src-badge scp-lb-src-global" style="font-size:9px;padding:1px 5px" title="Постоянная запись">★</span>' : ''}`;

        const warnEl = document.createElement('div');
        warnEl.style.cssText = 'font-size:10px;color:var(--scp-danger);margin-top:4px;width:100%;display:none;cursor:pointer;';
        warnEl.title = 'Нажмите, чтобы открыть панель редактирования и исправить вручную';
        itemMeta.appendChild(warnEl);

        const _activeBooks = getActiveLorebookNames();
        const _currentBook = editableChanges[ci].worldName || '';

        const worldDd = document.createElement('div');
        worldDd.className = 'scp-lb-proposal-world-dd';

        const worldTrigger = document.createElement('button');
        worldTrigger.className = 'scp-lb-proposal-world-trigger';
        worldTrigger.type = 'button';

        const worldTriggerText = document.createElement('span');
        worldTriggerText.className = 'scp-lb-proposal-world-trigger-text';
        worldTriggerText.textContent = `в ${getDisplayName(_currentBook) || '?'}`;

        const worldChevronEl = document.createElement('span');
        worldChevronEl.className = 'scp-lb-proposal-world-chevron';
        worldChevronEl.innerHTML = I.chevron;

        worldTrigger.appendChild(worldTriggerText);
        worldTrigger.appendChild(worldChevronEl);

        const worldPanel = document.createElement('div');
        worldPanel.className = 'scp-lb-proposal-world-panel';

        let _selectedBook = _currentBook;

        const buildWorldPanelItems = (items) => {
            worldPanel.innerHTML = '';
            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'scp-lb-proposal-world-empty';
                empty.textContent = 'Нет активных лорбуков';
                worldPanel.appendChild(empty);
            }
            items.forEach(name => {
                const item2 = document.createElement('div');
                item2.className = `scp-lb-proposal-world-item${name === _selectedBook ? ' active' : ''}`;
                item2.dataset.value = name;
                item2.innerHTML = `<span class="scp-lb-proposal-world-item-dot"></span><span>${escHtml(getDisplayName(name))}</span>`;
                item2.addEventListener('click', () => selectBook(name));
                worldPanel.appendChild(item2);
            });
            if (c.action === 'add') {
                const sep = document.createElement('div'); sep.className = 'scp-lb-proposal-world-sep';
                worldPanel.appendChild(sep);
                const newItem = document.createElement('div');
                newItem.className = 'scp-lb-proposal-world-item scp-lb-proposal-world-new';
                newItem.innerHTML = `<span>${I.plus}</span><span>Создать новый лорбук…</span>`;
                newItem.addEventListener('click', async () => {
                    worldPanel.classList.remove('open'); worldTrigger.classList.remove('open');
                    const name = await showCustomDialog({ type: 'prompt', title: 'Имя нового лорбука', message: 'Введите имя для нового лорбука:', placeholder: 'Мой лорбук' });
                    if (name?.trim()) {
                        const n = name.trim();
                        if (!_activeBooks.includes(n)) _activeBooks.push(n);
                        buildWorldPanelItems(_activeBooks);
                        selectBook(n);
                    }
                });
                worldPanel.appendChild(newItem);
            }
        };

        const _validateBookEntry = async (bookName) => {
            worldTrigger.classList.add('loading');
            const checkChange = { ...editableChanges[ci], worldName: bookName };
            if (bookName !== editableChanges[ci].worldName) delete checkChange.uid;
            
            const resolved = await resolveLBChangeTarget(checkChange, true);
            worldTrigger.classList.remove('loading');

            const found = !!resolved.origEntry;
            if (found) {
                const orig = resolved.origEntry;
                const n = orig.comment || `Запись #${orig.uid}`;
                editableChanges[ci].originalName = n;
                if (!editableChanges[ci].name) editableChanges[ci].name = n;
                
                const nameEl = item.querySelector('.scp-lb-pn-target');
                if (nameEl) nameEl.textContent = n;

                const nameInput = item.querySelector('.scp-lb-name-input');
                if (nameInput && !nameInput.value) nameInput.value = n;

                if (editableChanges[ci].triggers === null) {
                    const origKeys = orig.key || [];
                    editableChanges[ci].triggers = [...origKeys];
                    const tEl = item.querySelector('.scp-lb-proposal-triggers');
                    if (tEl) tEl.textContent = origKeys.length ? `Ключи: ${origKeys.join(', ')}` : 'Ключи: нет';
                    const tInput = item.querySelector('.scp-lb-trig-input');
                    if (tInput && !tInput.value) { tInput.value = origKeys.join(', '); tInput.placeholder = ''; }
                }
            }

            if (found && resolved.bookName && resolved.bookName !== bookName) {
                editableChanges[ci].worldName = resolved.bookName;
                _selectedBook = resolved.bookName;
                worldPanel.querySelectorAll('.scp-lb-proposal-world-item').forEach(el => el.classList.toggle('active', el.dataset.value === resolved.bookName));
                worldTriggerText.textContent = `в ${getDisplayName(resolved.bookName)}`;
                toastr.info(`Запись найдена в «<b>${escHtml(getDisplayName(resolved.bookName))}</b>» — лорбук переключён автоматически.`, EXT_DISPLAY, { escapeHtml: false });
            } else {
                worldTriggerText.textContent = found ? `в ${getDisplayName(bookName)}` : `в ${getDisplayName(bookName)} ⚠`;
            }

            let isValid = found;
            let reason = found ? '' : 'Запись не найдена в выбранном лорбуке';
            const ambiguous = [];
            if (found && editableChanges[ci].action === 'patch') {
                const orig = resolved.origEntry;
                let current = orig?.content || '';
                for (const patch of (editableChanges[ci].patches || [])) {
                    const r = applyPatchToField(current, patch);
                    if (!r.matched) {
                        if (r.occurrences >= 2) { ambiguous.push({ patch, occurrences: r.occurrences }); continue; }
                        isValid = false; reason = `ANCHOR не найден: «${(patch.search || patch.anchor || '').slice(0, 40)}...»`; break;
                    }
                    current = r.result;
                }
            }
            if (isValid && ambiguous.length) { isValid = false; reason = 'Якорь встречается несколько раз'; }

            if (!isValid) {
                applyItemBtn.disabled = true; applyItemBtn.title = reason;
                item.style.borderLeftColor = 'var(--scp-danger)';
                warnEl.textContent = `⚠ ${reason}`; warnEl.style.display = 'block';
                for (const amb of ambiguous) {
                    const allBtn = document.createElement('button');
                    allBtn.className = 'scp-anchor-all-btn';
                    allBtn.textContent = `⇄ Заменить все ${amb.occurrences}`;
                    allBtn.title = `Якорь «${(amb.patch.search || amb.patch.anchor || '').slice(0, 60)}» встречается ${amb.occurrences} раза — заменить все вхождения`;
                    allBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        amb.patch.all = true;
                        _validateBookEntry(_selectedBook);
                    });
                    warnEl.appendChild(allBtn);
                }
            } else {
                applyItemBtn.disabled = false; applyItemBtn.title = 'Применить это изменение';
                item.style.borderLeftColor = ''; warnEl.style.display = 'none';
            }
            worldTrigger.classList.toggle('warn', !found);
        };

        const selectBook = async (name) => {
            _selectedBook = name;
            editableChanges[ci].worldName = name;
            worldTriggerText.textContent = `в ${getDisplayName(name)}`;
            worldTrigger.classList.remove('warn');
            worldPanel.querySelectorAll('.scp-lb-proposal-world-item').forEach(el => el.classList.toggle('active', el.dataset.value === name));
            worldPanel.classList.remove('open'); worldTrigger.classList.remove('open');
            if (c.action !== 'add') await _validateBookEntry(name);
        };

        worldTrigger.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = worldPanel.classList.contains('open');
            document.querySelectorAll('.scp-lb-proposal-world-panel.open').forEach(p => { p.classList.remove('open'); p.previousElementSibling?.classList.remove('open'); });
            if (!isOpen) {
                const rect = worldTrigger.getBoundingClientRect();
                worldPanel.style.top = `${rect.bottom + 4}px`; worldPanel.style.left = `${rect.left}px`;
                worldPanel.classList.add('open'); worldTrigger.classList.add('open');
            }
        });

        const _allBooks = [..._activeBooks];
        if (_currentBook && !_activeBooks.includes(_currentBook)) _allBooks.unshift(_currentBook);
        buildWorldPanelItems(_allBooks);
        worldDd.appendChild(worldTrigger); worldDd.appendChild(worldPanel);

        const itemBtns = document.createElement('div');
        itemBtns.className = 'scp-lb-proposal-item-btns';

        let editToggleBtn = null;
        if (c.action !== 'delete') {
            editToggleBtn = document.createElement('button');
            editToggleBtn.className = 'scp-lb-proposal-edit-toggle';
            editToggleBtn.title = 'Изменить перед применением'; editToggleBtn.textContent = '✎';
            itemBtns.appendChild(editToggleBtn);
        }

        if (['edit', 'patch', 'prepend', 'append'].includes(c.action)) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'scp-lb-proposal-diff-btn';
            diffBtn.title = 'Показать различия'; diffBtn.innerHTML = I.diff;
            diffBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const change = editableChanges[ci];
                const { origEntry } = await resolveLBChangeTarget(change);
                if (!origEntry) { toastr.warning('Не удалось найти исходную запись для сравнения.', EXT_DISPLAY); return; }
                openDiffModal(change, origEntry);
            });
            itemBtns.appendChild(diffBtn);
        }

        const closeEditPanel = () => {
            const editPanel = item.querySelector('.scp-lb-proposal-edit-panel');
            if (editPanel && editPanel.style.display !== 'none') {
                editPanel.style.display = 'none';
                if (previewEl) previewEl.style.display = '';
                if (triggersEl) triggersEl.style.display = '';
                if (editToggleBtn) editToggleBtn.classList.remove('active');
            }
        };

        const applyItemBtn = document.createElement('button');
        applyItemBtn.className = 'scp-lb-proposal-item-apply';
        applyItemBtn.title = 'Применить это изменение'; applyItemBtn.textContent = '✓';
        applyItemBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (itemStates[ci] !== 'pending') return;
            closeEditPanel();
            applyItemBtn.disabled = true; applyItemBtn.textContent = '…';
            try {
                const applied = await applyLBChanges([editableChanges[ci]], card.dataset.for);
                if (!applied?.length) {
                    applyItemBtn.disabled = false; applyItemBtn.textContent = '✓';
                    return;
                }
                itemStates[ci] = 'applied'; item.classList.add('scp-lb-item-applied');
                itemBtns.querySelectorAll('button').forEach(b => { b.disabled = true; });
                updateCountBadge(); updateFooterBtns(); syncBlockToMessage(); checkAllResolved();
                toastr.success('[ЛБ] Изменение применено.', EXT_DISPLAY);
            } catch (err) {
                toastr.error(`Ошибка: ${err.message}`, EXT_DISPLAY);
                applyItemBtn.disabled = false; applyItemBtn.textContent = '✓';
            }
        });

        const rejectItemBtn = document.createElement('button');
        rejectItemBtn.className = 'scp-lb-proposal-item-reject';
        rejectItemBtn.title = 'Отклонить это изменение'; rejectItemBtn.textContent = '✕';
        rejectItemBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (itemStates[ci] !== 'pending') return;
            closeEditPanel(); itemStates[ci] = 'rejected';
            item.classList.add('scp-lb-item-rejected');
            itemBtns.querySelectorAll('button').forEach(b => { b.disabled = true; });
            logLBHistoryChanges([editableChanges[ci]], 'Rejected', card.dataset.for);
            updateCountBadge(); updateFooterBtns(); syncBlockToMessage(); checkAllResolved();
        });

        itemBtns.appendChild(applyItemBtn); itemBtns.appendChild(rejectItemBtn);
        itemHeader.appendChild(itemMeta); itemHeader.appendChild(itemBtns);
        item.appendChild(itemHeader); item.appendChild(worldDd);

        let previewEl = null, triggersEl = null;
        if (c.content) {
            previewEl = document.createElement('div');
            previewEl.className = 'scp-lb-proposal-preview';
            const isLong = c.content.length > 120;
            previewEl.textContent = isLong ? c.content.slice(0, 120) + '…' : c.content;
            if (isLong) {
                let _expanded = false;
                previewEl.title = 'Нажмите для раскрытия'; previewEl.style.cursor = 'pointer';
                previewEl.addEventListener('click', e => {
                    e.stopPropagation();
                    if (window.getSelection()?.toString()) return;
                    _expanded = !_expanded;
                    previewEl.textContent = _expanded ? c.content : c.content.slice(0, 120) + '…';
                    previewEl.style.whiteSpace = _expanded ? 'pre-wrap' : '';
                });
            }
            item.appendChild(previewEl);
        }
        if (c.triggers !== null && c.triggers?.length) {
            triggersEl = document.createElement('div'); triggersEl.className = 'scp-lb-proposal-triggers';
            triggersEl.textContent = 'Ключи: ' + c.triggers.join(', '); item.appendChild(triggersEl);
        } else if (c.triggers === null) {
            triggersEl = document.createElement('div'); triggersEl.className = 'scp-lb-proposal-triggers';
            triggersEl.style.opacity = '0.5'; triggersEl.textContent = 'Ключи: сохранить оригинальные'; item.appendChild(triggersEl);
        }

        if (c.action !== 'delete') {
            const editPanel = document.createElement('div');
            editPanel.className = 'scp-lb-proposal-edit-panel';
            editPanel.style.display = 'none';

            const mkRow = (labelHtml, el) => {
                const row = document.createElement('div'); row.className = 'scp-lb-pe-row';
                const lbl = document.createElement('label'); lbl.className = 'scp-lb-pe-label'; lbl.innerHTML = labelHtml;
                row.appendChild(lbl); row.appendChild(el); return row;
            };

            const nameInput = document.createElement('input');
            nameInput.type = 'text'; nameInput.className = 'scp-lb-pe-input scp-lb-name-input';
            nameInput.value = c.name || '';
            nameInput.addEventListener('input', () => { editableChanges[ci].name = nameInput.value; });
            editPanel.appendChild(mkRow('Имя', nameInput));

            const trigInput = document.createElement('input');
            trigInput.type = 'text'; trigInput.className = 'scp-lb-pe-input scp-lb-trig-input';
            trigInput.value = Array.isArray(c.triggers) ? c.triggers.join(', ') : '';
            trigInput.addEventListener('input', () => {
                const val = trigInput.value.trim();
                editableChanges[ci].triggers = val === '' ? [] : val.split(',').map(t => t.trim()).filter(Boolean);
            });
            editPanel.appendChild(mkRow('Ключи', trigInput));

            if (c.action === 'patch') {
                const rebuildPatches = () => {
                    const existing = editPanel.querySelector('.scp-lb-patches-wrap');
                    if (existing) existing.remove();
                    const patchWrap = document.createElement('div');
                    patchWrap.className = 'scp-lb-patches-wrap';
                    patchWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px';
                    (editableChanges[ci].patches || []).forEach((patch, pi) => {
                        const searchTa = document.createElement('textarea');
                        searchTa.className = 'scp-lb-pe-textarea'; searchTa.rows = 2; searchTa.value = patch.search || '';
                        searchTa.addEventListener('input', () => { editableChanges[ci].patches[pi].search = searchTa.value; });
                        const replaceTa = document.createElement('textarea');
                        replaceTa.className = 'scp-lb-pe-textarea'; replaceTa.rows = 3; replaceTa.value = patch.replace || '';
                        replaceTa.addEventListener('input', () => { editableChanges[ci].patches[pi].replace = replaceTa.value; });
                        patchWrap.appendChild(mkRow('Якорь (диапазон)', searchTa));
                        patchWrap.appendChild(mkRow('Замена', replaceTa));
                    });
                    editPanel.appendChild(patchWrap);
                };
                rebuildPatches();
            } else {
                const contentTa = document.createElement('textarea');
                contentTa.className = 'scp-lb-pe-textarea'; contentTa.value = c.content || '';
                contentTa.addEventListener('input', () => { editableChanges[ci].content = contentTa.value; });
                editPanel.appendChild(mkRow('Содержимое', contentTa));
            }

            const constWrap = document.createElement('label');
            constWrap.className = 'scp-sp-check'; constWrap.style.marginTop = '6px';
            const constCb = document.createElement('input');
            constCb.type = 'checkbox'; constCb.checked = !!c.constant;
            constCb.addEventListener('change', () => { editableChanges[ci].constant = constCb.checked; });
            constWrap.appendChild(constCb); constWrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'Постоянная (вставлять всегда)' }));
            
            const outletWrap = document.createElement('label');
            outletWrap.className = 'scp-sp-check'; outletWrap.style.marginTop = '6px';
            const outletCb = document.createElement('input');
            outletCb.type = 'checkbox'; outletCb.checked = !!c.outlet;
            outletWrap.appendChild(outletCb); outletWrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'Запись-аутлет' }));

            const outletNameRow = document.createElement('div');
            outletNameRow.className = 'scp-lb-pe-row';
            outletNameRow.style.display = c.outlet ? 'flex' : 'none';
            const oNameInp = document.createElement('input');
            oNameInp.type = 'text'; oNameInp.className = 'scp-lb-pe-input';
            oNameInp.value = c.outlet_name || '';
            oNameInp.placeholder = 'Имя макроса аутлета...';
            oNameInp.addEventListener('input', () => { editableChanges[ci].outlet_name = oNameInp.value; });
            outletNameRow.innerHTML = '<label class="scp-lb-pe-label">Имя аутлета</label>';
            outletNameRow.appendChild(oNameInp);

            outletCb.addEventListener('change', () => { 
                editableChanges[ci].outlet = outletCb.checked; 
                outletNameRow.style.display = outletCb.checked ? 'flex' : 'none';
            });

            editPanel.appendChild(constWrap);
            editPanel.appendChild(outletWrap);
            editPanel.appendChild(outletNameRow);

            item.appendChild(editPanel);

            if (editToggleBtn) {
                const toggleEditPanel = (e) => {
                    e.stopPropagation();
                    const isOpen = editPanel.style.display !== 'none';
                    editPanel.style.display = isOpen ? 'none' : 'flex';
                    if (previewEl) previewEl.style.display = isOpen ? '' : 'none';
                    if (triggersEl) triggersEl.style.display = isOpen ? '' : 'none';
                    editToggleBtn.classList.toggle('active', !isOpen);
                };
                editToggleBtn.addEventListener('click', toggleEditPanel);
                warnEl.addEventListener('click', (e) => { if (editPanel.style.display === 'none') toggleEditPanel(e); });
            }
        }

        list.appendChild(item);
        itemEls.push(item);
        if (c.action !== 'add' && itemStates[ci] === 'pending') _validateBookEntry(_selectedBook).catch(() => {});
    });

    const footer = document.createElement('div');
    footer.className = 'scp-lb-proposal-footer';
    const applyAllBtn = document.createElement('button');
    applyAllBtn.className = 'scp-lb-proposal-apply'; applyAllBtn.textContent = 'Применить всё';
    const rejectAllBtn = document.createElement('button');
    rejectAllBtn.className = 'scp-lb-proposal-reject'; rejectAllBtn.textContent = 'Отклонить всё';

    const updateCountBadge = () => { countBadge.textContent = getPendingCount() > 0 ? `${getPendingCount()} ожидает` : `${getAppliedCount()} применено`; };
    const updateFooterBtns = () => {
        applyAllBtn.style.display = getPendingCount() > 0 ? '' : 'none';
        rejectAllBtn.style.display = getPendingCount() > 0 ? '' : 'none';
    };

    applyAllBtn.addEventListener('click', async () => {
        const pending = editableChanges.filter((_, i) => itemStates[i] === 'pending');
        if (!pending.length) return;
        applyAllBtn.disabled = true; applyAllBtn.textContent = 'Применение…';
        try {
            const applied = await applyLBChanges(pending, card.dataset.for) || [];
            itemStates.forEach((s, i) => {
                if (s === 'pending' && applied.includes(editableChanges[i])) {
                    itemStates[i] = 'applied';
                    itemEls[i].classList.add('scp-lb-item-applied');
                    itemEls[i].querySelectorAll('button').forEach(b => { b.disabled = true; });
                }
            });
            updateCountBadge(); updateFooterBtns(); checkAllResolved();
            if (applied.length) toastr.success(`[ЛБ] ${applied.length} изменений применено.`, EXT_DISPLAY);
            if (applied.length < pending.length) {
                applyAllBtn.disabled = false; applyAllBtn.textContent = 'Применить всё';
            }
        } catch (e) {
            toastr.error(`Ошибка: ${e.message}`, EXT_DISPLAY);
            applyAllBtn.disabled = false; applyAllBtn.textContent = 'Применить всё';
        }
    });

    rejectAllBtn.addEventListener('click', () => {
        const rejectedChanges = [];
        itemStates.forEach((s, i) => {
            if (s === 'pending') {
                itemStates[i] = 'rejected'; itemEls[i].classList.add('scp-lb-item-rejected');
                itemEls[i].querySelectorAll('button').forEach(b => { b.disabled = true; });
                rejectedChanges.push(editableChanges[i]);
            }
        });
        if (rejectedChanges.length > 0) logLBHistoryChanges(rejectedChanges, 'Rejected', card.dataset.for);
        updateCountBadge(); updateFooterBtns(); checkAllResolved();
    });

    footer.appendChild(applyAllBtn); footer.appendChild(rejectAllBtn);
    card.appendChild(header); card.appendChild(list); card.appendChild(footer);
    const body = msgEl.querySelector('.scp-msg-body');
    if (body) body.insertBefore(card, body.querySelector('.scp-swipe-bar'));
    else msgEl.after(card);
    bringWindowToFront();
}
