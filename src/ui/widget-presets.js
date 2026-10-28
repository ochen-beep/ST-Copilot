// Widgets: quick-prompts bar, icon picker and the shared preset dropdown /
// preset-manager builders. Split out of ui-widgets.js (now a re-export
// facade); sounds/changelog/favorites and the context inspector live in
// sibling submodules.
import { EXT_DISPLAY, QP_ICON_POOL } from '../constants.js';
import { getSettings, saveSettings } from '../session.js';
import { escHtml, showCustomDialog, autoResize } from '../utils/util-dom.js';
import { recordStat, SM } from '../features/feature-stats.js';
// ─── Quick Prompts ───────────────────────────────────────────────────────────

export function renderQuickPromptsBar() {
    const bar = document.getElementById('scp-qp-bar');
    const toggleBtn = document.getElementById('scp-qp-toggle-btn');
    if (!bar) return;
    const s = getSettings();
    const prompts = s.quickPrompts || [];
    const visible = s.quickPromptsVisible && prompts.length > 0;

    bar.innerHTML = '';
    for (const qp of prompts) {
        const btn = document.createElement('button');
        btn.className = 'scp-qp-chip';
        const truncTitle = qp.text.length > 100 ? qp.text.slice(0, 100) + '…' : qp.text;
        btn.title = truncTitle;
        btn.innerHTML = `<span class="scp-qp-icon">${escHtml(qp.icon || '⚡')}</span><span class="scp-qp-label">${escHtml(qp.label || '')}</span>`;
        btn.addEventListener('click', () => {
            const input = document.getElementById('scp-input');
            if (!input) return;
            input.value = qp.text;
            autoResize(input);
            input.focus();
            recordStat(SM.qp);
        });
        bar.appendChild(btn);
    }

    if (visible) {
        bar.classList.add('scp-qp-bar--open');
    } else {
        bar.classList.remove('scp-qp-bar--open');
    }
    if (toggleBtn) toggleBtn.classList.toggle('active', s.quickPromptsVisible);
}

let _qpIconPickerEl = null;

export function showQPIconPicker(anchorEl, currentIcon, onSelect) {
    if (_qpIconPickerEl && _qpIconPickerEl.__anchor === anchorEl) { 
        _qpIconPickerEl.remove(); 
        _qpIconPickerEl = null; 
        return; 
    }
    if (_qpIconPickerEl) { _qpIconPickerEl.remove(); _qpIconPickerEl = null; }
    
    const pop = document.createElement('div');
    pop.className = 'scp-qp-icon-picker';
    pop.__anchor = anchorEl;

    for (const emoji of QP_ICON_POOL) {
        const btn = document.createElement('button');
        btn.className = `scp-qp-icon-option${emoji === currentIcon ? ' active' : ''}`;
        btn.textContent = emoji;
        btn.addEventListener('click', () => { onSelect(emoji); pop.remove(); _qpIconPickerEl = null; });
        pop.appendChild(btn);
    }
    document.body.appendChild(pop);
    _qpIconPickerEl = pop;
    const rect = anchorEl.getBoundingClientRect();
    pop.style.cssText = `position:fixed;z-index:2147483060;top:${rect.bottom + 4}px;left:${rect.left}px`;
    requestAnimationFrame(() => {
        const pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) pop.style.left = `${window.innerWidth - pr.width - 8}px`;
        if (pr.bottom > window.innerHeight - 8) pop.style.top = `${rect.top - pr.height - 6}px`;
    });
    const onOut = e => {
        if (!pop.contains(e.target) && e.target !== anchorEl) {
            pop.remove(); _qpIconPickerEl = null;
            document.removeEventListener('mousedown', onOut, true);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', onOut, true), 0);
}

// ─── Preset Dropdown ───────────────────────────────────────────

let _activePresetPanel = null;

export function openPresetDropdown(triggerEl, groups, onSelect, opts = {}) {
    const { placeholder = 'Поиск…', width = 320, emptyText = 'Здесь пусто' } = opts;

    if (_activePresetPanel) {
        _activePresetPanel.remove();
        _activePresetPanel = null;
        triggerEl.classList.remove('open');
        return;
    }

    triggerEl.classList.add('open');

    const panel = document.createElement('div');
    panel.className = 'scp-pdd-panel';
    panel.style.width = `${width}px`;
    _activePresetPanel = panel;

    const allItems = groups.flatMap(g => g.items);

    if (allItems.length > 6) {
        const sw = document.createElement('div');
        sw.className = 'scp-pdd-search-wrap';
        const si = document.createElement('input');
        si.type = 'text'; si.placeholder = placeholder;
        si.className = 'scp-pdd-search';
        si.addEventListener('input', () => renderContent(si.value.trim().toLowerCase()));
        sw.appendChild(si);
        panel.appendChild(sw);
        setTimeout(() => si.focus(), 60);
    }

    const listEl = document.createElement('div');
    listEl.className = 'scp-pdd-list';
    panel.appendChild(listEl);

    const renderContent = (q = '') => {
        listEl.innerHTML = '';
        let totalShown = 0;
        groups.forEach(group => {
            const filtered = q
                ? group.items.filter(it => it.name.toLowerCase().includes(q) || (it.preview || '').toLowerCase().includes(q))
                : group.items;
            if (!filtered.length) return;
            totalShown += filtered.length;
            if (group.label) {
                const hdr = document.createElement('div');
                hdr.className = 'scp-pdd-group-label';
                hdr.textContent = group.label;
                listEl.appendChild(hdr);
            }
            filtered.forEach(item => {
                const row = document.createElement('div');
                row.className = 'scp-pdd-item';
                const top = document.createElement('div');
                top.className = 'scp-pdd-item-top';
                const name = document.createElement('span');
                name.className = 'scp-pdd-item-name';
                name.textContent = item.name;
                top.appendChild(name);
                if (item.badge) {
                    const b = document.createElement('span');
                    b.className = `scp-pdd-badge scp-pdd-badge--${item.badge}`;
                    b.textContent = item.badge;
                    top.appendChild(b);
                }
                row.appendChild(top);
                if (item.preview) {
                    const prev = document.createElement('div');
                    prev.className = 'scp-pdd-item-preview';
                    prev.textContent = item.preview;
                    row.appendChild(prev);
                }
                row.addEventListener('click', () => {
                    onSelect(item.value, item.name, item);
                    closePresetPanel();
                });
                listEl.appendChild(row);
            });
        });
        if (!totalShown) {
            const empty = document.createElement('div');
            empty.className = 'scp-pdd-empty';
            empty.textContent = q ? 'Нет результатов' : emptyText;
            listEl.appendChild(empty);
        }
    };

    renderContent();
    document.body.appendChild(panel);

    const rect = triggerEl.getBoundingClientRect();
    panel.style.cssText += `;position:fixed;z-index:2147483060;top:${rect.bottom + 5}px;left:${rect.left}px;max-width:calc(100vw - 16px)`;
    requestAnimationFrame(() => {
        const pr = panel.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) panel.style.left = `${window.innerWidth - pr.width - 8}px`;
        if (pr.bottom > window.innerHeight - 8) panel.style.top = `${rect.top - pr.height - 5}px`;
    });

    setTimeout(() => {
        const onOut = e => {
            if (!panel.contains(e.target) && e.target !== triggerEl) {
                closePresetPanel();
                document.removeEventListener('mousedown', onOut, true);
            }
        };
        document.addEventListener('mousedown', onOut, true);
    }, 0);
}

export function closePresetPanel() {
    if (_activePresetPanel) { _activePresetPanel.remove(); _activePresetPanel = null; }
    document.querySelectorAll('.scp-pdd-trigger.open, .scp-preset-mgr-trigger.open')
        .forEach(el => el.classList.remove('open'));
}

export function buildPromptPresetManager(containerEl, getTextFn, setTextFn, dictKey = 'promptPresets') {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    const s = getSettings();
    if (!s[dictKey]) s[dictKey] = {};

    let _activeName = '';
    let _activeSource = '';

    const bar = document.createElement('div');
    bar.className = 'scp-preset-mgr-bar';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'scp-preset-mgr-trigger';
    trigger.innerHTML = `<span class="scp-pmt-label">Выберите пресет…</span><svg class="scp-pmt-chevron" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    const labelEl = trigger.querySelector('.scp-pmt-label');

    const setActive = (name, source) => {
        _activeName = name;
        _activeSource = source;
        labelEl.textContent = name || 'Выберите пресет…';
        trigger.classList.toggle('scp-pmt--has-value', !!name);
        updateBtnStates();
    };

    const buildGroups = () => {
        const groups = [];
        const profileItems = Object.keys(s.profiles || {})
            .filter(n => s.profiles[n].systemPrompt)
            .map(n => ({
                name: n,
                value: s.profiles[n].systemPrompt,
                preview: (s.profiles[n].systemPrompt || '').replace(/\s+/g, ' ').slice(0, 80),
                badge: 'profile',
                _source: 'profile',
            }));
        if (profileItems.length) groups.push({ label: 'Из профилей', items: profileItems });

        const customItems = Object.keys(s[dictKey])
            .map(n => ({
                name: n,
                value: s[dictKey][n],
                preview: (s[dictKey][n] || '').replace(/\s+/g, ' ').slice(0, 80),
                badge: 'custom',
                _source: 'custom',
            }));
        if (customItems.length) groups.push({ label: 'Пользовательские пресеты', items: customItems });
        return groups;
    };

    trigger.addEventListener('click', () => {
        const groups = buildGroups();
        openPresetDropdown(trigger, groups, (value, name, item) => {
            setTextFn(value);
            setActive(name, item._source || 'custom');
        }, { placeholder: 'Поиск пресетов…', width: 360, emptyText: 'Пресеты ещё не сохранены' });
    });

    const mkBtn = (icon, title, cls, cb) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `scp-preset-mgr-btn${cls ? ' ' + cls : ''}`;
        b.title = title;
        b.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
        b.addEventListener('click', cb);
        return b;
    };

    const saveBtn = mkBtn('floppy-disk', 'Сохранить пресет', '', async () => {
        if (_activeName && _activeSource === 'custom') {
            s[dictKey][_activeName] = getTextFn();
            saveSettings();
            toastr.success(`Пресет «${escHtml(_activeName)}» сохранён`, EXT_DISPLAY);
        } else {
            const name = await showCustomDialog({ type: 'prompt', title: 'Сохранить пресет промпта', message: 'Имя пресета:', placeholder: 'Мой пресет' });
            if (!name?.trim()) return;
            s[dictKey][name.trim()] = getTextFn();
            saveSettings();
            setActive(name.trim(), 'custom');
            toastr.success(`Пресет «${escHtml(name.trim())}» сохранён`, EXT_DISPLAY);
        }
    });

    const renameBtn = mkBtn('pen', 'Переименовать выбранный пользовательский пресет', '', async () => {
        if (!_activeName || _activeSource !== 'custom') { toastr.info('Сначала выберите пользовательский пресет.', EXT_DISPLAY); return; }
        const newName = await showCustomDialog({ type: 'prompt', title: 'Переименовать пресет', message: 'Новое имя:', defaultValue: _activeName });
        if (!newName?.trim() || newName.trim() === _activeName) return;
        s[dictKey][newName.trim()] = s[dictKey][_activeName];
        delete s[dictKey][_activeName];
        saveSettings();
        setActive(newName.trim(), 'custom');
    });

    const deleteBtn = mkBtn('trash', 'Удалить выбранный пользовательский пресет', 'danger', async () => {
        if (!_activeName || _activeSource !== 'custom') { toastr.info('Удалять можно только пользовательские пресеты.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить пресет', message: `Удалить «${_activeName}»?` });
        if (!ok) return;
        delete s[dictKey][_activeName];
        saveSettings();
        setActive('', '');
    });

    const updateBtnStates = () => {
        const isCustom = !!_activeName && _activeSource === 'custom';
        renameBtn.disabled = !isCustom;
        deleteBtn.disabled = !isCustom;
        renameBtn.style.opacity = isCustom ? '1' : '0.35';
        deleteBtn.style.opacity = isCustom ? '1' : '0.35';
    };
    updateBtnStates();

    bar.appendChild(trigger);
    bar.appendChild(saveBtn);
    bar.appendChild(renameBtn);
    bar.appendChild(deleteBtn);
    containerEl.appendChild(bar);
}

export function buildQPSetManager(containerEl, onSetLoaded) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    const s = getSettings();
    if (!s.quickPromptSets) s.quickPromptSets = {};

    let _activeName = s.activeQuickPromptSet || '';

    const bar = document.createElement('div');
    bar.className = 'scp-preset-mgr-bar';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'scp-preset-mgr-trigger';
    const getLabel = name => {
        if (!name) return 'Выберите набор…';
        const count = (s.quickPromptSets[name] || []).length;
        return `${name}  (${count})`;
    };
    trigger.innerHTML = `<span class="scp-pmt-label">${escHtml(getLabel(_activeName))}</span><svg class="scp-pmt-chevron" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    const labelEl = trigger.querySelector('.scp-pmt-label');

    const setActive = name => {
        _activeName = name;
        labelEl.textContent = getLabel(name);
        trigger.classList.toggle('scp-pmt--has-value', !!name);
        updateBtnStates();
    };

    const buildGroups = () => {
        const items = Object.keys(s.quickPromptSets).map(name => ({
            name,
            value: name,
            preview: `${(s.quickPromptSets[name] || []).length} prompts: ` +
                (s.quickPromptSets[name] || []).map(q => `${q.icon || '⚡'} ${q.label}`).join(', ').slice(0, 80),
            badge: name === s.activeQuickPromptSet ? 'active' : null,
        }));
        return [{ label: items.length ? 'Сохранённые наборы' : null, items }];
    };

    trigger.addEventListener('click', () => {
        openPresetDropdown(trigger, buildGroups(), (value) => {
            if (!s.quickPromptSets[value]) return;
            s.quickPrompts = JSON.parse(JSON.stringify(s.quickPromptSets[value]));
            s.activeQuickPromptSet = value;
            saveSettings();
            setActive(value);
            renderQuickPromptsBar();
            if (onSetLoaded) onSetLoaded();
            toastr.success(`Набор «${escHtml(value)}» загружен`, EXT_DISPLAY);
        }, { placeholder: 'Поиск наборов…', width: 340, emptyText: 'Наборы ещё не сохранены. Сохраните один ниже.' });
    });

    const mkBtn = (icon, title, cls, cb) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `scp-preset-mgr-btn${cls ? ' ' + cls : ''}`;
        b.title = title;
        b.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
        b.addEventListener('click', cb);
        return b;
    };

    const saveBtn = mkBtn('floppy-disk', 'Сохранить текущие промпты в активный набор (или новый)', '', async () => {
        let name = _activeName;
        if (!name) {
            name = await showCustomDialog({ type: 'prompt', title: 'Сохранить набор промптов', message: 'Имя набора:', placeholder: 'Мой набор' });
            if (!name?.trim()) return;
            name = name.trim();
        }
        s.quickPromptSets[name] = JSON.parse(JSON.stringify(s.quickPrompts));
        s.activeQuickPromptSet = name;
        saveSettings();
        setActive(name);
        toastr.success(`Набор «${escHtml(name)}» сохранён`, EXT_DISPLAY);
    });

    const saveAsBtn = mkBtn('plus', 'Сохранить текущие промпты как новый набор', '', async () => {
        const name = await showCustomDialog({ type: 'prompt', title: 'Новый набор промптов', message: 'Имя набора:', placeholder: 'Мой новый набор' });
        if (!name?.trim()) return;
        const n = name.trim();
        s.quickPromptSets[n] = JSON.parse(JSON.stringify(s.quickPrompts));
        s.activeQuickPromptSet = n;
        saveSettings();
        setActive(n);
        toastr.success(`Набор «${escHtml(n)}» создан`, EXT_DISPLAY);
    });

    const renameBtn = mkBtn('pen', 'Переименовать выбранный набор', '', async () => {
        if (!_activeName) { toastr.info('Сначала выберите набор.', EXT_DISPLAY); return; }
        const newName = await showCustomDialog({ type: 'prompt', title: 'Переименовать набор', message: 'Новое имя:', defaultValue: _activeName });
        if (!newName?.trim() || newName.trim() === _activeName) return;
        const n = newName.trim();
        s.quickPromptSets[n] = s.quickPromptSets[_activeName];
        delete s.quickPromptSets[_activeName];
        if (s.activeQuickPromptSet === _activeName) s.activeQuickPromptSet = n;
        saveSettings();
        setActive(n);
    });

    const deleteBtn = mkBtn('trash', 'Удалить выбранный набор', 'danger', async () => {
        if (!_activeName) { toastr.info('Сначала выберите набор.', EXT_DISPLAY); return; }
        const ok = await showCustomDialog({ type: 'confirm', title: 'Удалить набор', message: `Удалить набор «${_activeName}»?` });
        if (!ok) return;
        delete s.quickPromptSets[_activeName];
        if (s.activeQuickPromptSet === _activeName) s.activeQuickPromptSet = '';
        saveSettings();
        setActive('');
    });

    const updateBtnStates = () => {
        const has = !!_activeName;
        renameBtn.disabled = !has; renameBtn.style.opacity = has ? '1' : '0.35';
        deleteBtn.disabled = !has; deleteBtn.style.opacity = has ? '1' : '0.35';
    };
    updateBtnStates();

    bar.appendChild(trigger);
    bar.appendChild(saveBtn);
    bar.appendChild(saveAsBtn);
    bar.appendChild(renameBtn);
    bar.appendChild(deleteBtn);
    containerEl.appendChild(bar);
}
