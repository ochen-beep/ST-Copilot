// Settings engine: two-way binding of registered fields to the ST drawer and
// the settings overlay, plus the UI sync functions. Split out of ui-settings.js;
// profile/theme functions are imported from the sibling settings-profiles
// submodule directly, not through the facade.
import { getSettings, saveSettings, getEffectiveSettings, setSessionOverride, getCurrentSession, getSessionOverrides, hasSessionOverrides, getChatBucket, saveSessionsToMetadata } from '../session.js';
import { _SETTINGS_DEF, _CE_FIELDS_DEF, _OV_EL_MAP } from './settings-defs.js';
import { _markDirty, refreshProfilesDropdown, buildThemeEditor, updateSPConnProfileList, refreshSPProfilesDropdown } from './settings-profiles.js';
// ─── Settings Engine ──────────────────────────────────────────────────────────

export function _applyConnectionSourceVisibility(val) {
    [['scp-profile-group', 'scp-custom-profile-group'],
     ['scp-sp-global-profile-group', 'scp-sp-custom-profile-group']].forEach(([pId, cId]) => {
        const pEl = document.getElementById(pId); const cEl = document.getElementById(cId);
        if (pEl) pEl.style.display = val === 'profile' ? '' : 'none';
        if (cEl) cEl.style.display = val === 'custom' ? '' : 'none';
    });
    if (val === 'profile') updateSPConnProfileList();
}

export function _pruneMatchingOverrides() {
    const s = getSettings(); const bucket = getChatBucket(); let changed = false;
    
    if (bucket && bucket.sessions) {
        bucket.sessions.forEach(sess => {
            if (!sess.overrides) return;
            for (const key of Object.keys(sess.overrides)) {
                const globalVal = key.startsWith('charField_') ? (s.charEditFields || {})[key.replace('charField_', '')] !== false : s[key];
                const isEqual = typeof globalVal === 'boolean' ? sess.overrides[key] === globalVal : String(sess.overrides[key]) === String(globalVal);
                if (isEqual) { delete sess.overrides[key]; changed = true; }
            }
        });
        if (changed) { saveSessionsToMetadata(); updateSessionOverrideIndicator(); }
    }

    let charChanged = false;
    if (s.charMgrFieldOverrides) {
        for (const charId of Object.keys(s.charMgrFieldOverrides)) {
            const ovs = s.charMgrFieldOverrides[charId];
            for (const key of Object.keys(ovs)) {
                const globalVal = (s.charEditFields || {})[key] !== false;
                if (ovs[key] === globalVal) {
                    delete ovs[key];
                    charChanged = true;
                }
            }
            if (Object.keys(ovs).length === 0) {
                delete s.charMgrFieldOverrides[charId];
            }
        }
    }
    if (charChanged) saveSettings();
    
    document.querySelectorAll('.scp-char-ov-row').forEach(row => {
        if (typeof row._refreshOverride === 'function') row._refreshOverride();
    });
}

function _readFromSettings(def) {
    const s = getSettings();
    return def.fromSetting ? def.fromSetting(s) : s[def.key];
}

function _writeToEl(el, def, val) {
    if (!el) return;
    if (def.type === 'checkbox') el.checked = !!val;
    else el.value = val ?? '';
}

function _bindSetting(def) {
    const stEl = def.stId ? document.getElementById(def.stId) : null;
    const spEl = def.spId ? document.getElementById(def.spId) : null;
    if (!stEl && !spEl) return;

    const apply = raw => {
        const val = def.toVal ? def.toVal(raw) : raw;
        getSettings()[def.key] = val; saveSettings();
        _markDirty('config'); _pruneMatchingOverrides();
        if (def.onChange) def.onChange(val, getSettings());
        if (def.updCtx) import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
    };

    if (def.type === 'slider') {
        const setDisplayVal = (valId, v) => { const el = document.getElementById(valId); if (el) el.textContent = def.valFmt ? def.valFmt(v) : String(v); };
        stEl?.addEventListener('input', () => setDisplayVal(def.stValId, stEl.value));
        spEl?.addEventListener('input', () => setDisplayVal(def.spValId, spEl.value));
        stEl?.addEventListener('change', () => {
            const v = def.toVal ? def.toVal(stEl.value) : stEl.value;
            _writeToEl(spEl, def, v); setDisplayVal(def.stValId, v); setDisplayVal(def.spValId, v); apply(stEl.value);
        });
        spEl?.addEventListener('change', () => {
            const v = def.toVal ? def.toVal(spEl.value) : spEl.value;
            _writeToEl(stEl, def, v); setDisplayVal(def.stValId, v); setDisplayVal(def.spValId, v); apply(spEl.value);
        });
    } else {
        const isText = def.type === 'input' || def.type === 'textarea';
        const ev = isText ? 'input' : 'change';
        // Текстовые поля: apply (saveSettings + prune overrides + updateMsgCount)
        // дебаунсится, чтобы не платить за каждое нажатие клавиши;
        // синхронизация близнеца остаётся мгновенной.
        let _applyDebounce = 0;
        const applyMaybeDebounced = raw => {
            if (!isText) { apply(raw); return; }
            clearTimeout(_applyDebounce);
            _applyDebounce = setTimeout(() => apply(raw), 300);
        };
        stEl?.addEventListener(ev, () => { const raw = def.type === 'checkbox' ? stEl.checked : stEl.value; _writeToEl(spEl, def, raw); applyMaybeDebounced(raw); });
        spEl?.addEventListener(ev, () => { const raw = def.type === 'checkbox' ? spEl.checked : spEl.value; _writeToEl(stEl, def, raw); applyMaybeDebounced(raw); });
    }
}

function _bindCeField(ceDef) {
    const stEl = document.getElementById(ceDef.stId);
    const spEl = document.getElementById(ceDef.spId);
    const apply = val => {
        const s = getSettings(); if (!s.charEditFields) s.charEditFields = {};
        s.charEditFields[ceDef.fk] = val; saveSettings(); _markDirty('config'); _pruneMatchingOverrides();
        import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
        if (ceDef.altGreetingPicker) {
            ['scp-ce-alt-greetings-picker', 'scp-sp-ce-alt-greetings-picker'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = val ? '' : 'none'; });
            import('../features/feature-character-ui.js').then(m => m.refreshAltGreetingsPickers());
        }
    };
    stEl?.addEventListener('change', () => { if (spEl) spEl.checked = stEl.checked; apply(stEl.checked); });
    spEl?.addEventListener('change', () => { if (stEl) stEl.checked = spEl.checked; apply(spEl.checked); });
}

export function _bindAllSettings() {
    _SETTINGS_DEF.forEach(_bindSetting);
    _CE_FIELDS_DEF.forEach(_bindCeField);
}

export function _syncOvToGlobal(key, newVal) {
    const s = getSettings();
    const globalVal = key.startsWith('charField_') ? (s.charEditFields || {})[key.replace('charField_', '')] !== false : s[key];
    const isDefault = (newVal === undefined || newVal === null) ? true
        : (typeof globalVal === 'boolean' ? newVal === globalVal : String(newVal) === String(globalVal));
    setSessionOverride(key, isDefault ? undefined : newVal);
    updateSPOverrideIndicators();
    import('./ui-chat.js').then(m => m.updateMsgCount(getCurrentSession()));
}

export function _resetOvElToEffective(key) {
    const eff = getEffectiveSettings();
    (_OV_EL_MAP[key] || []).forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        if (id.endsWith('-depth-val') || (id.endsWith('-val') && !id.endsWith('slider'))) {
            el.textContent = eff.contextDepth ?? 15; return;
        }
        if (el.type === 'checkbox') {
            el.checked = key.startsWith('charField_') ? (getSettings().charEditFields || {})[key.replace('charField_', '')] !== false : !!eff[key];
        } else if (el.type === 'range') {
            el.value = eff[key] ?? 15;
        } else {
            el.value = eff[key] ?? '';
        }
    });
    if (key === 'connectionSource') {
        const val = eff.connectionSource ?? 'default';
        const pg = document.getElementById('scp-sp-ov-profile-group'); const cg = document.getElementById('scp-sp-ov-custom-profile-group');
        if (pg) pg.style.display = val === 'profile' ? '' : 'none';
        if (cg) cg.style.display = val === 'custom' ? '' : 'none';
    }
    if (key === 'forceStreaming') {
        const val = eff.forceStreaming === true ? 'on' : (eff.forceStreaming === false ? 'auto' : (eff.forceStreaming || 'auto'));
        document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
            const active = b.dataset.stream === val; b.classList.toggle('active', active);
            b.style.color = active ? 'var(--scp-accent)' : ''; b.style.borderColor = active ? 'var(--scp-accent-dim)' : ''; b.style.background = active ? 'var(--scp-accent-bg)' : '';
        });
    }
}

// ─── UI Sync ──────────────────────────────────────────────────────────────────

export function syncOverlayUI(key, val) {
    const def = _SETTINGS_DEF.find(d => d.key === key);
    if (def?.spId) {
        _writeToEl(document.getElementById(def.spId), def, val);
        if (def.type === 'slider' && def.spValId) { const el = document.getElementById(def.spValId); if (el) el.textContent = def.valFmt ? def.valFmt(val) : String(val ?? ''); }
    }
    if (key === 'forceStreaming') {
        const sv = val === true ? 'on' : (val === false ? 'auto' : (val || 'auto'));
        document.querySelectorAll('.scp-stream-btn:not(.scp-ov-stream-btn)').forEach(b => b.classList.toggle('active', b.dataset.stream === sv));
        if (!('forceStreaming' in getSessionOverrides())) document.querySelectorAll('.scp-ov-stream-btn').forEach(b => b.classList.toggle('active', b.dataset.stream === sv));
        return;
    }
    if (key === 'connectionSource') { _applyConnectionSourceVisibility(val); return; }
    if (key === 'contextDepth') { const dv = document.getElementById('scp-sp-depth-val'); if (dv) dv.textContent = val ?? 15; }
    if (key in getSessionOverrides()) return;
    if (key.startsWith('charField_')) {
        const ceDef = _CE_FIELDS_DEF.find(d => d.fk === key.replace('charField_', ''));
        if (ceDef) { const el = document.getElementById(ceDef.ovId); if (el) el.checked = !!val; }
        return;
    }
    if (_OV_EL_MAP[key]) _resetOvElToEffective(key);
}

export function updateSettingsUI() {
    const s = getSettings();
    for (const def of _SETTINGS_DEF) {
        const val = _readFromSettings(def);
        if (def.stId) _writeToEl(document.getElementById(def.stId), def, val);
        if (def.spId) _writeToEl(document.getElementById(def.spId), def, val);
        if (def.type === 'slider') {
            const fmt = def.valFmt ? def.valFmt(val) : String(val ?? '');
            [def.stValId, def.spValId].forEach(id => { if (!id) return; const el = document.getElementById(id); if (el) el.textContent = fmt; });
        }
    }
    for (const ceDef of _CE_FIELDS_DEF) {
        const val = (s.charEditFields || {})[ceDef.fk] !== false;
        if (ceDef.stId) { const el = document.getElementById(ceDef.stId); if (el) el.checked = val; }
        if (ceDef.spId) { const el = document.getElementById(ceDef.spId); if (el) el.checked = val; }
    }
    const fsVal = s.forceStreaming === true ? 'on' : (s.forceStreaming === false ? 'auto' : (s.forceStreaming || 'auto'));
    document.querySelectorAll('#scp-st-stream-auto, #scp-st-stream-on, #scp-st-stream-off').forEach(b => {
        const active = b.dataset.stream === fsVal; b.classList.toggle('active', active);
        b.style.color = active ? 'var(--SmartThemeQuoteColor,#a99bfb)' : ''; b.style.borderColor = active ? 'rgba(124,109,250,0.5)' : ''; b.style.background = active ? 'rgba(124,109,250,0.12)' : '';
    });
    _applyConnectionSourceVisibility(s.connectionSource ?? 'default');
    const agPicker = document.getElementById('scp-ce-alt-greetings-picker');
    if (agPicker) agPicker.style.display = s.charEditFields?.alternate_greetings ? '' : 'none';
    refreshProfilesDropdown(); buildThemeEditor();
    import('./ui-widgets.js').then(m => m.buildSoundSettingsUI(document.getElementById('scp-sound-settings')));
    import('../features/feature-character-ui.js').then(m => m.refreshAltGreetingsPickers());
}

export function syncSPFromSettings() {
    const s = getSettings(); const ov = getSessionOverrides(); const eff = getEffectiveSettings();
    import('./ui-chat.js').then(m => { if (m.updateDepthSlidersMax) m.updateDepthSlidersMax(); });

    for (const def of _SETTINGS_DEF) {
        if (!def.spId) continue;
        const val = _readFromSettings(def);
        _writeToEl(document.getElementById(def.spId), def, val);
        if (def.type === 'slider' && def.spValId) { const el = document.getElementById(def.spValId); if (el) el.textContent = def.valFmt ? def.valFmt(val) : String(val ?? ''); }
    }
    for (const ceDef of _CE_FIELDS_DEF) {
        const val = (s.charEditFields || {})[ceDef.fk] !== false;
        const el = document.getElementById(ceDef.spId); if (el) el.checked = val;
    }

    const streamVal = s.forceStreaming === true ? 'on' : (s.forceStreaming === false ? 'auto' : (s.forceStreaming || 'auto'));
    document.querySelectorAll('.scp-stream-btn:not(.scp-ov-stream-btn)').forEach(b => { b.classList.toggle('active', b.dataset.stream === streamVal); b.style.color = ''; b.style.borderColor = ''; b.style.background = ''; });
    _applyConnectionSourceVisibility(s.connectionSource ?? 'default');
    refreshSPProfilesDropdown(); updateSPConnProfileList();

    // ── Session Override UI ──
    const g  = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    const gC = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    const ovDs = document.getElementById('scp-sp-ov-depth-slider'); const ovDv = document.getElementById('scp-sp-ov-depth-val');
    if (ovDs) ovDs.value = eff.contextDepth ?? 15; if (ovDv) ovDv.textContent = eff.contextDepth ?? 15;

    g('scp-sp-ov-conn-source', eff.connectionSource ?? 'default');
    const ovPg = document.getElementById('scp-sp-ov-profile-group'); const ovCus = document.getElementById('scp-sp-ov-custom-profile-group');
    if (ovPg) ovPg.style.display = eff.connectionSource === 'profile' ? '' : 'none';
    if (ovCus) ovCus.style.display = eff.connectionSource === 'custom' ? '' : 'none';
    g('scp-sp-ov-conn-profile', eff.connectionProfileId ?? '');

    const ovi = (id, key) => { const el = document.getElementById(id); if (el) el.value = key in ov ? (ov[key] ?? '') : ''; };
    ovi('scp-sp-ov-custom-url', 'customUrl'); ovi('scp-sp-ov-custom-key', 'customKey'); ovi('scp-sp-ov-custom-model', 'customModel');
    ovi('scp-sp-ov-max-tokens', 'maxTokens'); ovi('scp-sp-ov-history-limit', 'localHistoryLimit');
    ovi('scp-sp-ov-reasoning-trim', 'reasoningTrimStrings'); ovi('scp-sp-ov-sysprompt', 'systemPrompt');
    ovi('scp-sp-ov-char-edit-prompt', 'charEditPrompt'); ovi('scp-sp-ov-lb-manage-prompt', 'lorebookManagePrompt'); ovi('scp-sp-ov-chat-edit-prompt', 'chatEditPrompt');

    gC('scp-sp-ov-include-sysprompt', eff.includeSystemPrompt); gC('scp-sp-ov-include-persona', eff.includeUserPersonality);
    gC('scp-sp-ov-include-alt-swipes', eff.includeAlternateSwipes); gC('scp-sp-ov-apply-regex', eff.applyRegexToContext);
    gC('scp-sp-ov-char-edit-enabled',  'charEditAIEnabled'        in ov ? ov.charEditAIEnabled        : s.charEditAIEnabled);
    gC('scp-sp-ov-lb-ai-enabled',      'lorebookAIManageEnabled'  in ov ? ov.lorebookAIManageEnabled  : s.lorebookAIManageEnabled);
    gC('scp-sp-ov-chat-edit-enabled',  'chatEditAIEnabled'        in ov ? ov.chatEditAIEnabled        : s.chatEditAIEnabled);
    gC('scp-sp-ov-lb-auto-kw',         'lorebookAutoKeyword'      in ov ? ov.lorebookAutoKeyword      : s.lorebookAutoKeyword);

    const ovStreamVal = eff.forceStreaming === true ? 'on' : (eff.forceStreaming === false ? 'auto' : (eff.forceStreaming || 'auto'));
    document.querySelectorAll('.scp-ov-stream-btn').forEach(b => {
        const active = b.dataset.stream === ovStreamVal; b.classList.toggle('active', active);
        b.style.color = active ? 'var(--scp-accent)' : ''; b.style.borderColor = active ? 'var(--scp-accent-dim)' : ''; b.style.background = active ? 'var(--scp-accent-bg)' : '';
    });
    for (const ceDef of _CE_FIELDS_DEF) {
        const ovKey = 'charField_' + ceDef.fk;
        const val = ovKey in ov ? !!ov[ovKey] : (s.charEditFields || {})[ceDef.fk] !== false;
        const el = document.getElementById(ceDef.ovId); if (el) el.checked = val;
    }
    const altGrOvEl = document.getElementById('scp-sp-ov-ce-alt-greetings');
    if (altGrOvEl) {
        const picker = document.getElementById('scp-sp-ov-ce-alt-greetings-picker');
        if (picker) picker.style.display = altGrOvEl.checked ? '' : 'none';
        import('../features/feature-character-ui.js').then(m => m.refreshAltGreetingsPickers());
    }
    updateSPOverrideIndicators();
    buildThemeEditor(document.getElementById('scp-sp-theme-section'));
    import('../features/feature-memory.js').then(m => m.updateMemoryDot());
}

export function updateSPOverrideIndicators() {
    const ov = getSessionOverrides();
    document.querySelectorAll('.scp-sp-ov-label[data-ovkey]').forEach(l => l.classList.toggle('has-override', l.dataset.ovkey in ov));
    document.querySelectorAll('.scp-sp-ov-clear[data-ovkey]').forEach(btn => {
        const active = btn.dataset.ovkey in ov; btn.classList.toggle('active', active); btn.disabled = !active;
    });
}

export function updateSessionOverrideIndicator() {
    const has = hasSessionOverrides();
    const dot = document.getElementById('scp-sp-override-dot'); if (dot) dot.style.display = has ? '' : 'none';
    const gearDot = document.getElementById('scp-gear-ov-dot'); if (gearDot) gearDot.style.display = has ? '' : 'none';
    document.getElementById('scp-ext-settings-btn')?.classList.toggle('scp-has-overrides', has);
    updateSPOverrideIndicators();
    const info = document.getElementById('scp-sp-footer-info');
    if (info) { const count = Object.keys(getSessionOverrides()).length; info.textContent = count ? `${count} ${count !== 1 ? 'переопределений сессии активно' : 'переопределение сессии активно'}` : ''; }
    const ov = getSessionOverrides(); const hasDepthOv = 'contextDepth' in ov;
    document.getElementById('scp-depth-slider')?.classList.toggle('scp-slider-overridden', hasDepthOv);
    document.getElementById('scp-depth-val')?.classList.toggle('scp-depth-val-overridden', hasDepthOv);
}
