// Lorebook UI: the lorebook manager overlay (book list, entry list, entry
// detail editor, event listeners). Split out of feature-lorebook-ui.js (now a
// re-export facade); the proposal card lives in a sibling submodule.
import { EXT_DISPLAY, I, THEME_PRESETS, EMBEDDED_BOOK_KEY } from '../constants.js';
import { state } from '../state.js';
import { getSettings, saveSettings, getCurrentSession } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { escHtml, showCustomDialog, copyText } from '../utils/util-dom.js';
import { fetchWorldInfoBook, saveWorldInfoBook, wiEntriesToArray, getDisplayName, getActiveLorebookNames, getEntryOverrideKey, buildLorebookContextBlock, wiCache, lastActiveEntries } from './feature-lorebook-engine.js';
import { applyCustomTheme, bringWindowToFront } from '../ui/ui-window.js';
import { updateMsgCount } from '../ui/ui-chat.js';
export async function openLorebookManager() {
    const overlay = document.getElementById('scp-lb-overlay');
    if (!overlay) return;
    _dbgAdd('LB_UI_OPEN');
    applyCustomTheme(getSettings().customTheme || THEME_PRESETS.default);
    overlay.style.display = 'flex';
    bringWindowToFront();
    const s = getSettings();
    if (document.getElementById('scp-lb-search')) document.getElementById('scp-lb-search').value = state.lbSearchQuery;
    
    // wiCache clear logic
    Object.keys(wiCache).forEach(k => delete wiCache[k]);
    
    await buildLorebookContextBlock(s).catch(() => {});
    await refreshLorebookList().catch(e => console.error(`[${EXT_DISPLAY}] LB list:`, e));
    if (state.lbActiveBook) await renderEntryList(state.lbActiveBook, state.lbSearchQuery).catch(() => {});
}

export function closeLorebookManager() {
    document.getElementById('scp-lb-overlay').style.display = 'none';
    _dbgAdd('LB_UI_CLOSE');
}

export function _applyLBBookCheckState(item, name, s) {
    const isSelected = s.lorebookSelectedBooks.includes(name);
    const isExcluded = (s.lorebookExcludedBooks || []).includes(name);
    const check = item.querySelector('.scp-lb-book-check');
    if (!check) return;
    check.classList.remove('checked', 'excluded');
    if (isSelected) check.classList.add('checked');
    else if (isExcluded) check.classList.add('excluded');
    check.title = isSelected ? 'Выбрано: все записи включены — нажмите, чтобы исключить' : isExcluded ? 'Исключено: все записи заблокированы — нажмите для сброса' : 'По умолчанию — нажмите, чтобы включить все';
    item.classList.toggle('selected', isSelected);
    item.classList.toggle('lb-excluded', isExcluded);
    const isForced = isSelected || isExcluded;
    if (item.classList.contains('lb-book-open')) {
        const entriesEl = document.getElementById('scp-lb-entries');
        if (entriesEl) entriesEl.classList.toggle('lb-entries-dimmed', isForced);
    }
}

export async function refreshLorebookList() {
    const listEl = document.getElementById('scp-lb-book-list');
    if (!listEl) return;
    const ctx = SillyTavern.getContext();
    if (typeof ctx.updateWorldInfoList === 'function') ctx.updateWorldInfoList().catch(() => {});
    const activeNamesArray = getActiveLorebookNames();
    const s = getSettings();
    listEl.innerHTML = '';
    
    if (!activeNamesArray.length) {
        listEl.innerHTML = '<div class="scp-lb-loading">Активные лорбуки не найдены.<br><small style="opacity:.5">Привяжите его к персонажу или выберите глобально.</small></div>';
        return;
    }
    
    await Promise.all(activeNamesArray.map(name => fetchWorldInfoBook(name)));
    
    const { ST_WorldInfo, ST_Utils } = await import('../index.js');
    
    // (G)
    const globalBooks = ST_WorldInfo?.selected_world_info || (ctx.worldInfoSettings?.globalSelect || []);
        
    // (Ch)
    const chatMetadata = window.chat_metadata || ctx.chatMetadata || {};
    const chatBook = chatMetadata.world_info || null;

    // (P)
    const pu = window.power_user || ctx.powerUserSettings || {};
    let personaBook = pu.persona_description_lorebook || null;
    if (!personaBook) {
        let personaId = window.user_avatar || ctx.user_avatar || ctx.userAvatar || ctx.personaId || ctx.activePersonaId || ctx.active_persona_id;
        if (typeof personaId === 'object' && personaId !== null) personaId = personaId.avatarId || personaId.id;
        if (personaId && pu.persona_descriptions?.[personaId]?.lorebook) {
            personaBook = pu.persona_descriptions[personaId].lorebook;
        }
    }

    //(C) - Primary + Additional
    const charBooks = new Set();
    const chars = window.characters || ctx.characters || [];
    
    chars.forEach((char, idx) => {
        if (!char) return;
        
        if (char.data?.extensions?.world) {
            charBooks.add(char.data.extensions.world);
        }
        
        if (ST_WorldInfo?.world_info?.charLore && Array.isArray(ST_WorldInfo.world_info.charLore)) {
            let fileName = char.avatar ? char.avatar.replace(/\.[^/.]+$/, '') : null;
            if (ST_Utils && typeof ST_Utils.getCharaFilename === 'function') {
                fileName = ST_Utils.getCharaFilename(idx);
            }
            
            const charLore = ST_WorldInfo.world_info.charLore.find(e => e.name === fileName);
            if (charLore && Array.isArray(charLore.extraBooks)) {
                charLore.extraBooks.forEach(b => charBooks.add(b));
            }
        }
    });

    const getSourceInfo = (name) => {
        if (name === EMBEDDED_BOOK_KEY) return { cls: 'scp-lb-src-character', label: 'C', title: 'Встроенный лорбук персонажа' };

        if (name === chatBook) return { cls: 'scp-lb-src-chat', label: 'Ч', title: 'Лорбук чата' };
        if (name === personaBook) return { cls: 'scp-lb-src-persona', label: 'P', title: 'Лорбук персоны' };
        if (charBooks.has(name)) return { cls: 'scp-lb-src-character', label: 'C', title: 'Лорбук персонажа (основной или дополнительный)' };
        if (globalBooks.includes(name)) return { cls: 'scp-lb-src-global', label: 'G', title: 'Глобальный лорбук' };

        return { cls: 'scp-lb-src-global', label: 'G', title: 'Глобальный лорбук' };
    };

    const frag = document.createDocumentFragment();
    for (const name of activeNamesArray) {
        const displayName = getDisplayName(name);
        const isSelected = s.lorebookSelectedBooks.includes(name);
        const isExcluded = (s.lorebookExcludedBooks || []).includes(name);
        const item = document.createElement('div');
        item.className = `scp-lb-book-item${isSelected ? ' selected' : ''}${isExcluded ? ' lb-excluded' : ''}${state.lbActiveBook === name ? ' lb-book-open' : ''}`;
        item.dataset.name = name;
        
        const cached = wiCache[name];
        const entryCount = cached ? Object.keys(cached.entries || {}).length : '…';
        
        const srcInfo = getSourceInfo(name);
        const checkState = isSelected ? 'checked' : isExcluded ? 'excluded' : '';
        
        item.innerHTML = `
            <div class="scp-lb-book-check${checkState ? ' ' + checkState : ''}" data-book="${escHtml(name)}"></div>
            <div class="scp-lb-book-info">
                <span class="scp-lb-book-name">${escHtml(displayName)}</span>
                <span class="scp-lb-book-meta">${entryCount} записей</span>
            </div>
            <span class="scp-lb-src-badge ${srcInfo.cls}" title="${srcInfo.title}" style="margin-left: auto;">${srcInfo.label}</span>`;
            
        item.querySelector('.scp-lb-book-check').addEventListener('click', e => { e.stopPropagation(); toggleLorebookSelection(name); });
        item.addEventListener('click', () => viewLorebookEntries(name));
        frag.appendChild(item);
    }
    
    listEl.appendChild(frag);
    updateLBFooterInfo();
}

export async function toggleLorebookSelection(name) {
    const s = getSettings();
    const isSelected = s.lorebookSelectedBooks.includes(name);
    const isExcluded = (s.lorebookExcludedBooks || []).includes(name);

    if (!isSelected && !isExcluded) {
        s.lorebookSelectedBooks.push(name);
        s.lorebookExcludedBooks = (s.lorebookExcludedBooks || []).filter(b => b !== name);
    } else if (isSelected) {
        s.lorebookSelectedBooks = s.lorebookSelectedBooks.filter(b => b !== name);
        if (!s.lorebookExcludedBooks) s.lorebookExcludedBooks = [];
        s.lorebookExcludedBooks.push(name);
    } else {
        s.lorebookExcludedBooks = s.lorebookExcludedBooks.filter(b => b !== name);
    }
    saveSettings();
    await buildLorebookContextBlock(s);
    const item = document.querySelector(`.scp-lb-book-item[data-name="${CSS.escape(name)}"]`);
    if (item) _applyLBBookCheckState(item, name, s);
    updateLBFooterInfo();
    updateMsgCount(getCurrentSession());
    if (state.lbActiveBook) renderEntryList(state.lbActiveBook, state.lbSearchQuery);
}

export async function viewLorebookEntries(name) {
    state.lbActiveBook = name;
    document.querySelectorAll('.scp-lb-book-item').forEach(el => el.classList.toggle('lb-book-open', el.dataset.name === name));
    document.getElementById('scp-lb-main-actions').style.display = '';
    document.getElementById('scp-lb-ctx-legend').style.display = '';
    document.getElementById('scp-lb-entry-detail').style.display = 'none';
    document.getElementById('scp-lb-entries').style.display = '';
    const s = getSettings();
    const isForced = s.lorebookSelectedBooks.includes(name) || (s.lorebookExcludedBooks || []).includes(name);
    const entriesEl = document.getElementById('scp-lb-entries');
    if (entriesEl) entriesEl.classList.toggle('lb-entries-dimmed', isForced);
    await renderEntryList(name, state.lbSearchQuery);
}

export async function renderEntryList(bookName, search = '') {
    const container = document.getElementById('scp-lb-entries');
    if (!container) return;
    const data = await fetchWorldInfoBook(bookName);
    if (!data) { container.innerHTML = '<div class="scp-lb-empty-state">Не удалось загрузить лорбук</div>'; return; }

    const entries = wiEntriesToArray(data);
    const s = getSettings();
    const overrides = s.lorebookEntryOverrides || {};
    const isBookSelected = (s.lorebookSelectedBooks || []).includes(bookName);
    const activeEntryUids = new Set(
        lastActiveEntries.filter(e => e.bookName === bookName).map(e => e.uid)
    );
    const lowerSearch = search.toLowerCase();
    const filtered = search ? entries.filter(e => {
        return (e.comment || '').toLowerCase().includes(lowerSearch)
            || (e.content || '').toLowerCase().includes(lowerSearch)
            || (e.key || []).join(' ').toLowerCase().includes(lowerSearch);
    }) : entries;

    const label = document.getElementById('scp-lb-entries-label');
    if (label) label.textContent = `${getDisplayName(bookName)} — ${filtered.length}${filtered.length !== entries.length ? ` из ${entries.length}` : ''} ${filtered.length === 1 ? 'запись' : 'записей'}`;

    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
        const overKey = getEntryOverrideKey(bookName, entry);
        const override = overrides[overKey];
        const isDisabled = !!entry.disable;
        const isInCtx = activeEntryUids.has(entry.uid);
        const row = document.createElement('div');
        row.className = `scp-lb-entry-row${isDisabled ? ' lb-disabled' : ''}${isInCtx ? ' lb-in-ctx' : ''}`;
        row.dataset.uid = entry.uid;

        let indClass = '', btnText = '~';
        if (override === true) { indClass = 'forced-on'; btnText = '✓'; }
        else if (override === false) { indClass = 'forced-off'; btnText = '✕'; }
        else if (entry.constant && !entry.disable) { indClass = 'forced-on'; btnText = '✓'; }
        else if (isInCtx) { indClass = 'scp-lb-ind-in-ctx'; }

        row.innerHTML = `
            <div class="scp-lb-entry-indicator ${indClass}"></div>
            <div class="scp-lb-entry-info">
                <span class="scp-lb-entry-name">${escHtml(entry.comment || `#${entry.uid}`)}${isInCtx ? ' <span class="scp-lb-in-ctx-badge">в контексте</span>' : ''}</span>
                <span class="scp-lb-entry-keys">${entry.key?.slice(0, 5).map(k => escHtml(k)).join(' · ') || '—'}</span>
            </div>
            <div class="scp-lb-entry-actions">
                <button class="scp-lb-entry-toggle-btn ${indClass}">${btnText}</button>
                <button class="scp-lb-entry-view-btn">${I.edit}</button>
            </div>`;
        row.querySelector('.scp-lb-entry-toggle-btn').addEventListener('click', e => { e.stopPropagation(); cycleEntryOverride(bookName, entry, row); });
        row.querySelector('.scp-lb-entry-view-btn').addEventListener('click', e => { e.stopPropagation(); showEntryDetail(entry, bookName); });
        row.addEventListener('click', () => showEntryDetail(entry, bookName));
        frag.appendChild(row);
    }
    container.innerHTML = '';
    container.appendChild(frag);
}

export function cycleEntryOverride(bookName, entry, rowEl) {
    const s = getSettings();
    if (!s.lorebookEntryOverrides) s.lorebookEntryOverrides = {};
    const key = getEntryOverrideKey(bookName, entry);
    const current = s.lorebookEntryOverrides[key];
    const isConstantEntry = !!entry.constant && !entry.disable;
    let next;
    if (current === undefined) next = isConstantEntry ? false : true;
    else if (current === true) next = false;
    else { delete s.lorebookEntryOverrides[key]; next = undefined; }
    if (next !== undefined) s.lorebookEntryOverrides[key] = next;

    saveSettings();

    const ind = rowEl.querySelector('.scp-lb-entry-indicator');
    const btn = rowEl.querySelector('.scp-lb-entry-toggle-btn');
    if (next === true) {
        ind.className = 'scp-lb-entry-indicator forced-on';
        btn.textContent = '✓'; btn.className = 'scp-lb-entry-toggle-btn forced-on';
        rowEl.classList.remove('lb-in-ctx');
    } else if (next === false) {
        ind.className = 'scp-lb-entry-indicator forced-off';
        btn.textContent = '✕'; btn.className = 'scp-lb-entry-toggle-btn forced-off';
        rowEl.classList.remove('lb-in-ctx');
    } else {
        const isInCtx = lastActiveEntries.some(e => e.bookName === bookName && e.uid === entry.uid);
        ind.className = `scp-lb-entry-indicator${isConstantEntry ? ' forced-on' : (isInCtx ? ' scp-lb-ind-in-ctx' : '')}`;
        btn.textContent = isConstantEntry ? '✓' : '~'; 
        btn.className = `scp-lb-entry-toggle-btn${isConstantEntry ? ' forced-on' : ''}`;
        rowEl.classList.toggle('lb-in-ctx', isInCtx);
    }
    updateMsgCount(getCurrentSession());
}

export function showEntryDetail(entry, bookName) {
    state.lbEntryDetailEntry = entry;
    state.lbEntryDetailBook = bookName;
    document.getElementById('scp-lb-entry-detail').style.display = 'flex';
    document.getElementById('scp-lb-entries').style.display = 'none';

    document.getElementById('scp-lb-detail-title').textContent = entry.comment || `Запись #${entry.uid}`;
    document.getElementById('scp-lb-detail-name').value = entry.comment || '';
    document.getElementById('scp-lb-detail-triggers').value = (entry.key || []).join(', ');
    document.getElementById('scp-lb-detail-content').value = entry.content || '';

    const lbStatus = document.getElementById('scp-lb-detail-lb-status');
    if (lbStatus) {
        const updateStatus = () => {
            lbStatus.textContent = entry.disable ? 'Отключено' : 'Включено';
            lbStatus.className = `scp-lb-detail-status ${entry.disable ? 'status-disabled' : 'status-enabled'}`;
        };
        updateStatus();
        lbStatus.onclick = async () => {
            entry.disable = !entry.disable;
            updateStatus();
            const data = await fetchWorldInfoBook(bookName);
            if (data?.entries[entry.uid] !== undefined) {
                data.entries[entry.uid].disable = entry.disable;
                try {
                    await saveWorldInfoBook(bookName, data);
                } catch (e) {
                    toastr.error(`[ЛБ] Не сохранено: ${e.message}`, EXT_DISPLAY, { timeOut: 10000 });
                    return;
                }
                toastr.success('Статус обновлён', EXT_DISPLAY);
                renderEntryList(bookName, state.lbSearchQuery);
            }
        };
    }

    const s = getSettings();
    const override = (s.lorebookEntryOverrides || {})[getEntryOverrideKey(bookName, entry)];
    ['scp-lb-inj-default', 'scp-lb-inj-force-on', 'scp-lb-inj-force-off'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    if (override === true) document.getElementById('scp-lb-inj-force-on')?.classList.add('active');
    else if (override === false) document.getElementById('scp-lb-inj-force-off')?.classList.add('active');
    else document.getElementById('scp-lb-inj-default')?.classList.add('active');
}

export async function saveEntryDetail() {
    if (!state.lbEntryDetailEntry || !state.lbEntryDetailBook) return;
    if (state.lbEntryDetailBook === EMBEDDED_BOOK_KEY) { toastr.warning('Нельзя сохранять записи встроенного лорбука персонажа.', EXT_DISPLAY); return; }
    const data = await fetchWorldInfoBook(state.lbEntryDetailBook);
    if (!data) return;
    const entry = data.entries[state.lbEntryDetailEntry.uid];
    entry.comment = document.getElementById('scp-lb-detail-name')?.value || '';
    entry.key = (document.getElementById('scp-lb-detail-triggers')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
    entry.content = document.getElementById('scp-lb-detail-content')?.value || '';
    Object.assign(state.lbEntryDetailEntry, entry);
    await saveWorldInfoBook(state.lbEntryDetailBook, data);

    toastr.success('Запись сохранена', EXT_DISPLAY);
    document.getElementById('scp-lb-detail-title').textContent = entry.comment || `Запись #${entry.uid}`;
    renderEntryList(state.lbEntryDetailBook, state.lbSearchQuery);
    updateMsgCount(getCurrentSession());
}

export async function deleteEntryDetail() {
    if (!state.lbEntryDetailEntry || !state.lbEntryDetailBook) return;
    if (state.lbEntryDetailBook === EMBEDDED_BOOK_KEY) { toastr.warning('Нельзя удалять записи встроенного лорбука персонажа.', EXT_DISPLAY); return; }
    const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить запись', message: `Удалить «${state.lbEntryDetailEntry.comment || 'эту запись'}»?` });
    if (!ok) return;
    const data = await fetchWorldInfoBook(state.lbEntryDetailBook);
    if (!data) return;
    delete data.entries[state.lbEntryDetailEntry.uid];
    await saveWorldInfoBook(state.lbEntryDetailBook, data);

    toastr.success('Запись удалена', EXT_DISPLAY);
    document.getElementById('scp-lb-entry-detail').style.display = 'none';
    document.getElementById('scp-lb-entries').style.display = '';
    renderEntryList(state.lbEntryDetailBook, state.lbSearchQuery);
    updateMsgCount(getCurrentSession());
}

export async function addNewEntry() {
    if (!state.lbActiveBook) { toastr.warning('Сначала выберите лорбук', EXT_DISPLAY); return; }
    if (state.lbActiveBook === EMBEDDED_BOOK_KEY) { toastr.warning('Нельзя добавлять записи во встроенные лорбуки персонажа.', EXT_DISPLAY); return; }
    const name = await showCustomDialog({ type: 'prompt', title: 'Новая запись', message: 'Имя записи:', placeholder: 'Новая запись' });
    if (name === null) return;
    const data = await fetchWorldInfoBook(state.lbActiveBook);
    if (!data) return;
    const uids = Object.keys(data.entries).map(Number);
    const newUid = uids.length ? Math.max(...uids) + 1 : 1;
    const newEntry = {
        uid: newUid, key: [], keysecondary: [], content: '',
        comment: name.trim() || 'Новая запись', disable: false, group: '',
        selective: false, constant: false, position: 0, depth: 4, displayIndex: newUid
    };

    data.entries[newUid] = newEntry;
    await saveWorldInfoBook(state.lbActiveBook, data);
    toastr.success('Запись создана', EXT_DISPLAY);
    await renderEntryList(state.lbActiveBook, state.lbSearchQuery);
    showEntryDetail(newEntry, state.lbActiveBook);
    updateMsgCount(getCurrentSession());
}

export function updateLBFooterInfo() {
    const el = document.getElementById('scp-lb-footer-info');
    if (!el) return;
    
    const activeNames = getActiveLorebookNames() || [];
    const s = getSettings();
    
    const count = (s.lorebookSelectedBooks || []).filter(b => activeNames.includes(b)).length;
    const excCount = (s.lorebookExcludedBooks || []).filter(b => activeNames.includes(b)).length;
    
    const kwOn = s.lorebookAutoKeyword;
    const parts = [];
    if (count) parts.push(`${count} ${count !== 1 ? 'книг' : 'книга'} выбрано`);
    if (excCount) parts.push(`${excCount} исключено`);
    if (kwOn) parts.push('Авто-ключевые слова ВКЛ');
    el.textContent = parts.join(' · ');
}

export function setupLorebookManagerListeners() {
    document.getElementById('scp-lb-close')?.addEventListener('click', closeLorebookManager);
    
    document.getElementById('scp-lb-refresh')?.addEventListener('click', async () => {
        Object.keys(wiCache).forEach(k => delete wiCache[k]);
        await refreshLorebookList();
        if (state.lbActiveBook) await renderEntryList(state.lbActiveBook, state.lbSearchQuery);
    });

    let _lbSearchTid = null;
    document.getElementById('scp-lb-search')?.addEventListener('input', e => {
        state.lbSearchQuery = e.target.value;
        clearTimeout(_lbSearchTid);
        _lbSearchTid = setTimeout(() => { if (state.lbActiveBook) renderEntryList(state.lbActiveBook, state.lbSearchQuery); }, 200);
    });

    document.getElementById('scp-lb-enable-all')?.addEventListener('click', () => {
        if (!state.lbActiveBook || !wiCache[state.lbActiveBook]) return;
        const s = getSettings();
        Object.values(wiCache[state.lbActiveBook].entries).forEach(e => { s.lorebookEntryOverrides[getEntryOverrideKey(state.lbActiveBook, e)] = true; });
        saveSettings(); renderEntryList(state.lbActiveBook, state.lbSearchQuery);
        import('../ui/ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
    });
    
    document.getElementById('scp-lb-disable-all')?.addEventListener('click', () => {
        if (!state.lbActiveBook || !wiCache[state.lbActiveBook]) return;
        const s = getSettings();
        Object.values(wiCache[state.lbActiveBook].entries).forEach(e => { s.lorebookEntryOverrides[getEntryOverrideKey(state.lbActiveBook, e)] = false; });
        saveSettings(); renderEntryList(state.lbActiveBook, state.lbSearchQuery);
        import('../ui/ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
    });
    
    document.getElementById('scp-lb-reset-overrides')?.addEventListener('click', async () => {
        if (!state.lbActiveBook) return;
        const ok = await showCustomDialog({ type: 'confirm', title: 'Сбросить переопределения', message: `Сбросить все переопределения инъекций copilot для «${state.lbActiveBook}»?` });
        if (!ok) return;
        const s = getSettings();
        if (wiCache[state.lbActiveBook]) Object.values(wiCache[state.lbActiveBook].entries).forEach(e => { delete s.lorebookEntryOverrides[getEntryOverrideKey(state.lbActiveBook, e)]; });
        saveSettings(); renderEntryList(state.lbActiveBook, state.lbSearchQuery);
        import('../ui/ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
    });

    document.getElementById('scp-lb-add-entry')?.addEventListener('click', addNewEntry);
    
    document.getElementById('scp-lb-back')?.addEventListener('click', async () => {
        document.getElementById('scp-lb-entry-detail').style.display = 'none';
        document.getElementById('scp-lb-entries').style.display = '';
        await buildLorebookContextBlock(getSettings());
        if (state.lbActiveBook) await renderEntryList(state.lbActiveBook, state.lbSearchQuery);
    });
    
    document.getElementById('scp-lb-detail-save')?.addEventListener('click', saveEntryDetail);
    document.getElementById('scp-lb-detail-delete')?.addEventListener('click', deleteEntryDetail);
    
    document.getElementById('scp-lb-detail-copy')?.addEventListener('click', () => {
        const c = document.getElementById('scp-lb-detail-content')?.value; if (c) copyText(c);
    });
    
    ['scp-lb-inj-default', 'scp-lb-inj-force-on', 'scp-lb-inj-force-off'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () => {
            if (!state.lbEntryDetailEntry || !state.lbEntryDetailBook) return;
            const val = document.getElementById(id)?.dataset.val;
            const s = getSettings();
            if (!s.lorebookEntryOverrides) s.lorebookEntryOverrides = {};
            const key = getEntryOverrideKey(state.lbEntryDetailBook, state.lbEntryDetailEntry);
            if (val === 'default') delete s.lorebookEntryOverrides[key];
            else s.lorebookEntryOverrides[key] = val === 'true';
            
            saveSettings();
            ['scp-lb-inj-default', 'scp-lb-inj-force-on', 'scp-lb-inj-force-off'].forEach(bid => document.getElementById(bid)?.classList.remove('active'));
            document.getElementById(id)?.classList.add('active');
            showEntryDetail(state.lbEntryDetailEntry, state.lbEntryDetailBook);
            import('../ui/ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
        });
    });

    const ctx = SillyTavern.getContext();
    const es = ctx.eventSource || window.eventSource;
    const et = ctx.event_types || window.event_types || {};
    es?.on?.(et.WORLDINFO_UPDATED || 'worldinfo_updated', (name) => {
        const overlay = document.getElementById('scp-lb-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        refreshLorebookList();
        if (state.lbActiveBook && name === state.lbActiveBook) {
            renderEntryList(state.lbActiveBook, state.lbSearchQuery);
        }
    });
}