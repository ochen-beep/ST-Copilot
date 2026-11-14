import { EXT_DISPLAY, EMBEDDED_BOOK_KEY, DEFAULT_LB_MANAGE_PROMPT, LB_FORMAT_BLOCK } from '../constants.js';
import { getCurrentSession, saveSettings, expandMacros } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { ST_WorldInfo, ST_Utils } from '../version.js';
import { isMsgHidden } from '../utils/util-st.js';
import { _repairJSON } from '../utils/util-text.js';
import { invalidateSystemPromptCache } from '../state.js';

export const wiCache = {};
export const wiPromises = {};
export let lastActiveEntries = [];

let _wiExternalListenerBound = false;
export function setupExternalWIChangeListener() {
    if (_wiExternalListenerBound) return;
    _wiExternalListenerBound = true;
    const ctx = SillyTavern.getContext();
    const es = ctx.eventSource || window.eventSource;
    const et = ctx.event_types || window.event_types || {};
    if (!es) return;
    es.on(et.WORLDINFO_UPDATED || 'worldinfo_updated', (name) => {
        if (name) delete wiCache[name];
        // WI контент попадает в системный промпт через buildLorebookContextBlock.
        // Чистка wiCache НЕ чистит systemPromptCache — Promise с уже собранным lb-блоком
        // остался бы stale, поэтому бампаем явно.
        invalidateSystemPromptCache('WORLDINFO_UPDATED');
    });
    es.on(et.WORLDINFO_SETTINGS_UPDATED || 'worldinfo_settings_updated', () => {
        for (const key of Object.keys(wiCache)) delete wiCache[key];
        invalidateSystemPromptCache('WORLDINFO_SETTINGS_UPDATED');
    });
}

export async function fetchWorldInfoBook(name) {
    if (name === EMBEDDED_BOOK_KEY) return getEmbeddedCharBook();
    
    if (wiCache[name] && Date.now() - (wiCache[name]._ts || 0) < 30000) return wiCache[name];
    if (wiPromises[name]) return wiPromises[name];

    const ctx = SillyTavern.getContext();
    
    wiPromises[name] = (async () => {
        try {
            let data = null;
            if (typeof ctx.loadWorldInfo === 'function') {
                data = await ctx.loadWorldInfo(name);
            } else {
                const res = await fetch('/api/worldinfo/get', {
                    method: 'POST',
                    headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            }
            if (!data) return null;
            data._ts = Date.now();
            _normalizeWIBook(data);
            wiCache[name] = data;
            return data;
        } catch (e) {
            _dbgAdd('LB_LOAD_FILE_FAILED', { bookName: name, error: e.message });
            console.error(`[${EXT_DISPLAY}] WI load failed for "${name}":`, e);
            return null;
        } finally {
            delete wiPromises[name];
        }
    })();

    return wiPromises[name];
}

// Lorebook files come in two shapes: modern { entries: { uid: entry } } and the
// legacy/embedded array form { entries: [entry, ...] }. All write paths below use
// object semantics (entries[uid], delete entries[uid]) — on an array that leaves
// holes which JSON.stringify saves as `null` (seen in the wild: corrupted
// entries[0] = null killed the whole WI pipeline). Normalize once at the load
// boundary so every consumer sees the object shape.
export function _normalizeWIBook(data) {
    if (!data || !Array.isArray(data.entries)) return;
    const obj = {};
    data.entries.forEach((e, idx) => {
        if (!e || typeof e !== 'object') return;
        const uid = e.uid ?? e.id ?? idx;
        if (e.uid === undefined) e.uid = uid;
        obj[uid] = e;
    });
    data.entries = obj;
}

export function getEmbeddedCharBook() {
    const ctx = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    const book = char?.data?.character_book;
    if (!book?.entries?.length) return null;
    
    const data = { entries: {}, _embedded: true, _ts: Date.now() };

    (book.entries || []).forEach((e, idx) => {
        const uid = e.id ?? idx;
        const keys = Array.isArray(e.keys) ? e.keys : (e.key || []);
        const outlet = e.automation_id || e.automationId || e.extensions?.outlet_name || e.outletName || e.outlet_name || e.outlet || '';
        const isOutlet = Boolean(outlet); 
        const isForceConstant = e.selective === false; 

        data.entries[uid] = {
            uid,
            key: keys,
            keysecondary: [],
            content: e.content || '',
            comment: e.name || '',
            disable: false,
            selective: true,
            constant: !isOutlet && (e.constant === true || isForceConstant),
            position: isOutlet ? 7 : (e.position ?? 0),
            displayIndex: uid,
            automation_id: outlet,
            outletName: outlet,
            outlet: e.outlet || e.outlet_name || e.outletName || '',
            group: e.group || (isOutlet ? outlet : ''),
            role: null,
            extensions: { outlet_name: outlet },
            order: e.order ?? 100,
            probability: e.probability ?? 100,
            groupWeight: e.groupWeight ?? 100,
            depth: 4,
            useProbability: true,
            addMemo: true,
            groupOverride: false,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            ignoreBudget: false,
            vectorized: false,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false
        };
    });

    return data;
}

export async function saveWorldInfoBook(name, data) {
    if (data._embedded) {
        // Embedded character books live inside the card file; a WI save would be
        // a silent no-op. Callers must see a real failure, not a fake success.
        throw new Error('Embedded character lorebook cannot be saved directly');
    }
    const ctx = SillyTavern.getContext();
    // Глубокая копия: в payload не должно быть живых ссылок на кэш — иначе
    // неудачный сейв оставляет кэш мутированным относительно диска.
    const payload = structuredClone(data);
    delete payload._ts;
    _normalizeWIBook(payload);
    try {
        if (typeof ctx.saveWorldInfo === 'function') {
            // overwrite=true: без флага часть сборок ST мержит, а не перезаписывает.
            await ctx.saveWorldInfo(name, payload, true);
        } else {
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, data: payload }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => res.statusText);
                throw new Error(`HTTP ${res.status}: ${errText}`);
            }
        }
    } catch (e) {
        _dbgAdd('LB_SAVE_FILE_FAILED', { bookName: name, error: e.message });
        console.error(`[${EXT_DISPLAY}] saveWorldInfoBook failed for "${name}":`, e);
        throw e;
    }
    delete wiCache[name];
    
    try {
        if (typeof ctx.reloadWorldInfoEditor === 'function') {
            ctx.reloadWorldInfoEditor(name, true);
        }
    } catch (_) {}
}

export function getDisplayName(name) {
    if (name === EMBEDDED_BOOK_KEY) {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        return `[${char?.name || 'Character'} Book]`;
    }
    return name;
}

export function getActiveLorebookNames() {
    const ctx = SillyTavern.getContext();
    const names = new Set();

    const globalBooks = ST_WorldInfo?.selected_world_info || window.selected_world_info ||[];
    if (Array.isArray(globalBooks)) {
        globalBooks.forEach(n => n && names.add(n));
    }

    const charId = ctx.characterId;
    const character = ctx.characters?.[charId];
    if (character) {
        const baseWorldName = character.data?.extensions?.world || character.world;
        if (baseWorldName && typeof baseWorldName === 'string') names.add(baseWorldName);

        let fileName = character.avatar;
        if (ST_Utils && typeof ST_Utils.getCharaFilename === 'function') {
            fileName = ST_Utils.getCharaFilename(charId);
        }
        const charLoreList = ST_WorldInfo?.world_info?.charLore || window.world_info?.charLore;
        if (fileName && Array.isArray(charLoreList)) {
            const extraCharLore = charLoreList.find(e => e.name === fileName);
            if (extraCharLore && Array.isArray(extraCharLore.extraBooks)) {
                extraCharLore.extraBooks.forEach(book => book && names.add(book));
            }
        }
    }

    const wiKey = ST_WorldInfo?.METADATA_KEY || window.WI_METADATA_KEY || 'world_info';
    const chatWorldName = ctx.chatMetadata?.[wiKey];
    if (chatWorldName && typeof chatWorldName === 'string') names.add(chatWorldName);

    const personaWorldName = ctx.powerUserSettings?.persona_description_lorebook;
    if (personaWorldName && typeof personaWorldName === 'string') names.add(personaWorldName);

    return [...names].filter(Boolean);
}

export function wiEntriesToArray(data) {
    if (!data?.entries) return [];
    return Object.values(data.entries).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
}

// Tool-facing visibility: tools must see exactly what the user configured for
// the Copilot. Excluded books and ST-disabled entries never reach the model
// unless the entry was explicitly forced on via lorebookEntryOverrides === true.
export function isBookVisibleToTools(name, settings) {
    return !bookListHas(settings.lorebookExcludedBooks, name);
}

export function isEntryVisibleToTools(bookName, entry, settings) {
    if (!entry.disable) return true;
    const overrides = settings.lorebookEntryOverrides || {};
    return overrides[getEntryOverrideKey(bookName, entry)] === true;
}

// Book names may carry stray leading/trailing spaces from manual edits or old
// exports; real names can also legally contain spaces ("Grid "), so stored
// data is never mutated — only comparisons are normalized on both sides.
export function bookNameEq(a, b) {
    return String(a).trim() === String(b).trim();
}

export function bookListHas(list, name) {
    return (list || []).some(b => bookNameEq(b, name));
}

export function bookListRemove(list, name) {
    return (list || []).filter(b => !bookNameEq(b, name));
}

export function keywordMatchEntry(keys, text) {
    if (!keys?.length || !text) return false;
    const lower = text.toLowerCase();
    return keys.some(k => {
        if (!k) return false;
        try {
            const m = k.match(/^\/(.+)\/([gimsuy]*)$/);
            if (m) return new RegExp(m[1], m[2]).test(text);
        } catch (_) {}
        return lower.includes(k.toLowerCase());
    });
}

export function getKeywordTriggeredEntries(allBooksData, text1, text2) {
    const scanText = [text1, text2].filter(Boolean).join('\n');
    const results = {};
    for (const [bookName, data] of Object.entries(allBooksData)) {
        const entries = wiEntriesToArray(data);
        const matched = entries.filter(e => !e.disable && (keywordMatchEntry(e.key, scanText) || keywordMatchEntry(e.keysecondary, scanText)));
        if (matched.length) results[bookName] = matched;
    }
    return results;
}

export function getEntryOverrideKey(bookName, entry) {
    let entryName = String(entry.comment || entry.name || '').trim();
    if (!entryName && entry.key && entry.key.length) {
        entryName = entry.key.join('_').slice(0, 40);
    }
    entryName = String(entryName).replace(/[\r\n]+/g, ' ').trim();
    return entryName ? `${bookName}_${entryName}` : `${bookName}_${entry.uid}`;
}

export async function buildLorebookContextBlock(settings) {
    lastActiveEntries = [];
    const selectedBooks = settings.lorebookSelectedBooks || [];
    const overrides = settings.lorebookEntryOverrides || {};
    const loadedBooks = {};
    const _activeNamesSet = new Set(getActiveLorebookNames());

    if (!_activeNamesSet.size) return '';

    await Promise.all([..._activeNamesSet].map(async name => {
        if (bookListHas(settings.lorebookExcludedBooks, name)) return;
        const data = await fetchWorldInfoBook(name);
        if (data) loadedBooks[name] = data;
    }));

    if (!Object.keys(loadedBooks).length) return '';

    let keywordEntries = {};
    if (settings.lorebookAutoKeyword) {
        const ctx = SillyTavern.getContext();
        const msgs = ctx.chat || [];
        const incHidden = !!settings.includeHiddenMessages;
        let lastUser = '', lastChar = '';

        try {
            const session = getCurrentSession();
            const picked = session.pickedChatIndices;
            if (picked && picked.length > 0) {
                const pickedMsgs = picked.filter(i => i >= 0 && i < msgs.length).map(i => msgs[i]).filter(m => !isMsgHidden(m, incHidden));
                lastUser = pickedMsgs.filter(m => m.is_user).map(m => m.mes).join('\n');
                lastChar = pickedMsgs.filter(m => !m.is_user).map(m => m.mes).join('\n');
            } else {
                const stDepth = Math.max(1, settings.lorebookSTScanDepth ?? 5);
                const recentMsgs = msgs.filter(m => !isMsgHidden(m, incHidden)).slice(-stDepth);
                lastUser = recentMsgs.filter(m => m.is_user).map(m => m.mes).join('\n');
                lastChar = recentMsgs.filter(m => !m.is_user).map(m => m.mes).join('\n');
            }
        } catch (_) {
            const stDepth = Math.max(1, settings.lorebookSTScanDepth ?? 5);
            const recentMsgs = msgs.filter(m => !isMsgHidden(m, incHidden)).slice(-stDepth);
            lastUser = recentMsgs.filter(m => m.is_user).map(m => m.mes).join('\n');
            lastChar = recentMsgs.filter(m => !m.is_user).map(m => m.mes).join('\n');
        }

        let copilotScanText = '';
        try {
            const session = getCurrentSession();
            const copilotDepth = settings.lorebookCopilotScanDepth ?? 6;
            copilotScanText = session.messages
                .filter(m => !m.isLBHistory)
                .slice(-copilotDepth)
                .map(m => m.content)
                .join('\n');
        } catch (_) {}

        keywordEntries = getKeywordTriggeredEntries(loadedBooks, lastUser + '\n' + lastChar, copilotScanText);
    }

    const toInject = {};
    const outletLines = [];
    let overridesChanged = false;

    for (const [bookName, data] of Object.entries(loadedBooks)) {
        for (const entry of wiEntriesToArray(data)) {
            if (!entry.content) continue;

            const oldKey = `${bookName}_${entry.uid}`;
            const newKey = getEntryOverrideKey(bookName, entry);

            if (oldKey !== newKey && overrides[oldKey] !== undefined) {
                overrides[newKey] = overrides[oldKey];
                delete overrides[oldKey];
                overridesChanged = true;
            }

            const override = overrides[newKey];
            if (override === false) continue;

            const isConstant = !!entry.constant && !entry.disable;
            const manualInclude = bookListHas(selectedBooks, bookName);
            const keywordInclude = keywordEntries[bookName]?.some(e => e.uid === entry.uid);

            if (override === true || isConstant || manualInclude || keywordInclude) {
                const outletField = (entry.outlet || entry.outlet_name || entry.outletName || entry.automation_id || entry.automationId || '').trim();
                const isOutletPos = String(entry.position).toLowerCase() === 'outlet' || String(entry.position) === '7';
                const finalOutletName = outletField || (isOutletPos ? (entry.group || '').trim() : '');
                const isOutlet = isOutletPos || finalOutletName !== '';

                if (isOutlet) {
                    if (!entry.disable) {
                        outletLines.push(`### ${entry.comment || `Entry #${entry.uid}`} (uid: ${entry.uid}, book: "${getDisplayName(bookName)}") [outlet name: ${finalOutletName}]\n${entry.content}`);
                        lastActiveEntries.push({
                            bookName,
                            displayName: getDisplayName(bookName),
                            entryName: entry.comment || `#${entry.uid}`,
                            uid: entry.uid,
                        });
                    }
                    continue;
                }

                if (!toInject[bookName]) toInject[bookName] = [];
                toInject[bookName].push(entry);
            }
        }
    }

    if (overridesChanged) saveSettings();

    if (!Object.keys(toInject).length && !outletLines.length) return '';

    let block = '\n\n<lorebook_context>\n';
    for (const [bookName, entries] of Object.entries(toInject)) {
        let hasValidEntries = false;
        let bookBlock = `## ${getDisplayName(bookName)}\n`;

        for (const e of entries) {
            hasValidEntries = true;
            bookBlock += `### ${e.comment || `Entry #${e.uid}`} (uid: ${e.uid})`;
            if (e.key?.length) bookBlock += ` [keys: ${e.key.slice(0, 5).join(', ')}]`;
            bookBlock += `\n${e.content}\n\n`;

            lastActiveEntries.push({
                bookName,
                displayName: getDisplayName(bookName),
                entryName: e.comment || `#${e.uid}`,
                uid: e.uid,
            });
        }
        if (hasValidEntries) block += bookBlock;
    }

    if (outletLines.length) {
        block += `## Outlet Entries (injected only where an outlet::<name> macro is manually placed elsewhere, not directly)\n${outletLines.join('\n\n')}\n\n`;
    }

    if (block === '\n\n<lorebook_context>\n') return '';

    block += '</lorebook_context>';
    return block;
}

export function buildLBAIInstructions(settings) {
    if (!settings.lorebookAIManageEnabled) return '';
    // Активны = книги, реально подключённые к чату (глобальные/персонажа/чата/персоны),
    // а не только те, из которых сработали записи. Иначе пустая или несработавшая книга
    // невидима для модели, и она предлагает создать новую вместо использования существующей.
    const activeBooks = getActiveLorebookNames()
        .filter(b => !bookListHas(settings.lorebookExcludedBooks, b))
        .map(b => getDisplayName(b));
    const activeBooksStr = activeBooks.length > 0 ? activeBooks.map(b => `"${b}"`).join(', ') : 'None';
    
    let rawPrompt = settings.lorebookManagePrompt || DEFAULT_LB_MANAGE_PROMPT;
    
    if (!rawPrompt.includes('{{active_lorebooks}}')) {
        if (rawPrompt.includes('Format requirment:')) {
            rawPrompt = rawPrompt.replace('Format requirment:', `Active lorebooks: {{active_lorebooks}}\n\nFormat requirment:`);
        } else {
            rawPrompt = `Active lorebooks: {{active_lorebooks}}\n\n` + rawPrompt;
        }
    }

    const prompt = rawPrompt
        .replace('{{active_lorebooks}}', activeBooksStr)
        .replace('{{lorebook_output}}', LB_FORMAT_BLOCK);
        
    return `<lorebook_management>\n${prompt}\n</lorebook_management>`;
}

export function _parseLBDiffPatch(str) {
    const m = str.match(/<<<<<<< (?:SEARCH|ANCHOR)\r?\n([\s\S]*?)\r?\n=+\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/);
    return m ? { search: m[1], replace: m[2] } : null;
}

export function _sanitizeLBChanges(changes) {
    if (!Array.isArray(changes)) return null;
    const valid = [];
    for (const c of changes) {
        if (!c || typeof c !== 'object') continue;
        if (!['add', 'edit', 'patch', 'prepend', 'append', 'delete'].includes(c.action)) continue;
        if (!c.worldName && !c.name && c.uid == null) continue;
        if (c.triggers === 'original' || c.triggers === 'keep' || c.triggers === undefined || c.triggers === null) {
            c.triggers = null;
        } else if (!Array.isArray(c.triggers)) {
            c.triggers = String(c.triggers).split(',').map(s => s.trim()).filter(Boolean);
        }
        if (c.constant !== undefined) c.constant = !!c.constant;
        if (c.action === 'patch' && Array.isArray(c.patches)) {
            c.patches = c.patches.map(p => {
                if (typeof p === 'string') return _parseLBDiffPatch(p);
                if (p && typeof p === 'object') {
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

export function parseLBChangesFromText(text) {
    let raw = null;
    const strict = text.match(/```lorebook-changes\s*([\s\S]*?)```/);
    if (strict) {
        raw = strict[1].trim();
    } else {
        const open = text.match(/```lorebook-changes\s*([\s\S]*?)(?=```|$)/);
        if (open) raw = open[1].trim();
    }
    if (!raw) return null;
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.changes)) return _sanitizeLBChanges(data.changes);
    } catch (_) {}
    try {
        const repaired = _repairJSON(raw);
        const data = JSON.parse(repaired);
        if (Array.isArray(data.changes)) return _sanitizeLBChanges(data.changes);
    } catch (_) {}
    try {
        const lines = raw.split('\n');
        const fixed = lines.map(line => {
            return line.replace(/("(?:content|name|comment|search|replace|triggers)":\s*)"((?:[^"\\]|\\.)*)"/, (match, prefix, val) => {
                const escaped = val.replace(/(?<!\\)"/g, '\\"');
                return `${prefix}"${escaped}"`;
            });
        }).join('\n');
        const data = JSON.parse(fixed);
        if (Array.isArray(data.changes)) return _sanitizeLBChanges(data.changes);
    } catch (_) {}

    if (raw) _dbgAdd('LB_PROPOSAL_PARSING_FAILED', { rawText: raw.slice(0, 300) + (raw.length > 300 ? '...' : '') });
    return null;
}

export function stripLBChangesBlock(text) {
    return text
        .replace(/```lorebook-changes[\s\S]*?```/g, '')
        .replace(/```lorebook-changes[\s\S]*/g, '')
        .trim();
}

export async function bindNewLorebookToCharacter(bookName) {
    try {
        const ctx = SillyTavern.getContext();

        const allBooks = window.world_names || ST_WorldInfo?.world_names || [];
        const isNew = !allBooks.includes(bookName);

        if (isNew) {
            console.log('[ST-Copilot-Debug] Lorebook is new. Requesting ST to create...');
            if (typeof ST_WorldInfo?.createNewWorldInfo === 'function') {
                await ST_WorldInfo.createNewWorldInfo(bookName);
            } else if (typeof window.createNewWorldInfo === 'function') {
                await window.createNewWorldInfo(bookName);
            } else {
                const payload = { entries: {}, extensions: {} };
                await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: bookName, data: payload }),
                });
                if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();
                else if (typeof window.loadWorldInfoList === 'function') await window.loadWorldInfoList();
            }
            toastr.success(`Лорбук «${bookName}» успешно создан.`, EXT_DISPLAY);
        }

        delete wiCache[bookName];

        const charId = ctx.characterId;
        if (charId === undefined || charId === null) return;

        let fileName = ctx.characters?.[charId]?.avatar;
        if (ST_Utils && typeof ST_Utils.getCharaFilename === 'function') {
            fileName = ST_Utils.getCharaFilename(charId);
        } else if (typeof window.getCharaFilename === 'function') {
            fileName = window.getCharaFilename(charId);
        }
        if (!fileName) return;

        let wiSettings = window.world_info || ST_WorldInfo?.world_info;
        if (!wiSettings) return;

        if (!Array.isArray(wiSettings.charLore)) wiSettings.charLore = [];

        const charLoreList = wiSettings.charLore;
        let extraCharLore = charLoreList.find(e => e.name === fileName);
        if (!extraCharLore) {
            extraCharLore = { name: fileName, extraBooks: [] };
            charLoreList.push(extraCharLore);
        }
        if (!Array.isArray(extraCharLore.extraBooks)) extraCharLore.extraBooks = [];

        if (!extraCharLore.extraBooks.includes(bookName)) {
            extraCharLore.extraBooks.push(bookName);
            console.log(`[ST-Copilot-Debug] Added "${bookName}" to extraBooks.`);

            if (typeof ST_WorldInfo?.saveWorldInfoSettings === 'function') ST_WorldInfo.saveWorldInfoSettings();
            else if (typeof window.saveWorldInfoSettings === 'function') window.saveWorldInfoSettings();

            if (typeof window.saveSettingsDebounced === 'function') window.saveSettingsDebounced();
            else if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();

            if (typeof ST_WorldInfo?.printWorldInfoCharacters === 'function') ST_WorldInfo.printWorldInfoCharacters();
            else if (typeof window.printWorldInfoCharacters === 'function') window.printWorldInfoCharacters();
        }
    } catch (e) {
        _dbgAdd('LB_AUTO_BIND_NEW_BOOK_FAILED', { bookName, error: e.message });
        console.error(`[ST-Copilot-Debug] Exception in bindNewLorebookToCharacter:`, e);
    }
}

export async function resolveLBChangeTarget(change, strictBook = false) {
    let bookName = change.worldName || '';
    let targetUid = change.uid;
    const targetName = (change.originalName || change.name || '').trim().toLowerCase();
    const hasUid = targetUid !== undefined && targetUid !== null;

    if (bookName === getDisplayName(EMBEDDED_BOOK_KEY)) bookName = EMBEDDED_BOOK_KEY;

    let data = await fetchWorldInfoBook(bookName);
    if (!data && bookName && !strictBook) {
        // Имя книги — только точное: «Aria» не должно ловить «Aria's World».
        const match = getActiveLorebookNames().find(n => n.toLowerCase() === bookName.toLowerCase());
        if (match) {
            bookName = match;
            data = await fetchWorldInfoBook(bookName);
        }
    }

    // uid авторитетен и локален для книги. Без uid — только точное имя записи.
    // Подстрочные совпадения убраны: «Aria» не должно править «Aria's sword».
    const pickEntry = (entries) => {
        if (hasUid) {
            const byUid = entries.filter(en => String(en.uid) === String(targetUid));
            return byUid.length === 1 ? byUid[0] : null;
        }
        if (!targetName) return null;
        const byName = entries.filter(en => (en.comment || `Entry #${en.uid}`).trim().toLowerCase() === targetName);
        return byName.length === 1 ? byName[0] : null;
    };

    let origEntry = null;
    if (data && data.entries) {
        origEntry = pickEntry(Object.values(data.entries));
    }

    // Голое число в имени = uid записи (модели иногда ссылаются номером).
    if (!origEntry && /^\d+$/.test(targetName) && data && data.entries[targetName]) {
        origEntry = data.entries[targetName];
    }

    if (!origEntry && targetName && !strictBook) {
        for (const name of getActiveLorebookNames()) {
            if (name === bookName) continue;
            const bd = await fetchWorldInfoBook(name);
            if (!bd) continue;
            const m = pickEntry(Object.values(bd.entries));
            if (m) {
                origEntry = m;
                bookName = name;
                data = bd;
                break;
            }
        }
    }

    if (!data) {
        console.warn(`[${EXT_DISPLAY}] resolveLBChangeTarget: no book data found`, {
            change, resolvedBookName: bookName, activeBooks: getActiveLorebookNames(), cacheKeys: Object.keys(wiCache)
        });
    } else if (!origEntry && change.action !== 'add') {
        console.warn(`[${EXT_DISPLAY}] resolveLBChangeTarget: entry not found (uid/name must be exact and unambiguous)`, {
            targetName, targetUid, bookName,
            entries: Object.values(data.entries || {}).map(e => ({ uid: e.uid, comment: e.comment, key: e.key?.slice(0, 3) }))
        });
    }
    return { bookName, data, origEntry };
}

export async function expandOutletsAsync(text, depth = 0) {
    if (!text || typeof text !== 'string' || !text.includes('{{outlet::') || depth > 3) return text;

    const outletRegex = /\{\{outlet::(.*?)\}\}/gi;
    const matches = [...new Set([...text.matchAll(outletRegex)].map(m => m[1]))];
    
    if (!matches.length) return text;

    const activeNames = getActiveLorebookNames();
    
    if (!activeNames.includes(EMBEDDED_BOOK_KEY)) {
        activeNames.push(EMBEDDED_BOOK_KEY);
    }

    const loadedBooks = [];
    for (const name of activeNames) {
        const data = await fetchWorldInfoBook(name);
        if (data) loadedBooks.push(data);
    }

    let result = text;
    for (const name of matches) {
        const searchName = name.trim();
        const matchedEntries = [];

        for (const book of loadedBooks) {
            const entries = Object.values(book.entries || {});
            for (const e of entries) {
                const outletField = (e.outlet || e.outlet_name || e.outletName || e.automation_id || e.automationId || '').trim();
                const isOutletPos = String(e.position) === '7' || String(e.position).toLowerCase() === 'outlet';
                const finalOutletName = outletField || (isOutletPos ? (e.group || '').trim() : '');
                
                if (!e.disable && finalOutletName === searchName) {
                    matchedEntries.push(e);
                }
            }
        }

        const replacementText = matchedEntries.map(e => expandMacros(e.content || '')).join('\n');
        
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\{\\{outlet::${escapedName}\\}\\}`, 'g');
        
        // функция-заменитель: $-последовательности в контенте записи не интерпретируются
        result = result.replace(regex, () => replacementText);
    }

    if (result.includes('{{outlet::')) {
        result = await expandOutletsAsync(result, depth + 1);
    }

    return result;
}