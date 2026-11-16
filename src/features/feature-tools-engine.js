import { DEFAULT_TOOLS_PROMPT, TOOL_CALL_FORMAT_BLOCK, TOOL_DEFINITIONS } from '../constants.js';
import { getSettings, getEffectiveSettings } from '../session.js';
import { state } from '../state.js';
import { _ensureWrapped } from '../utils/util-text.js';
import { parseToolCallsFromText, stripToolCallsFromText, extractProviderToolCalls, findToolCallCut } from '../utils/util-tool-parse.js';
import { getCharInfo, getTagsForCharacter, isMsgHidden } from '../utils/util-st.js';
import { fetchWorldInfoBook, getDisplayName, getActiveLorebookNames, wiEntriesToArray, isBookVisibleToTools, isEntryVisibleToTools, bookNameEq } from './feature-lorebook-engine.js';

export { parseToolCallsFromText, stripToolCallsFromText, extractProviderToolCalls, findToolCallCut };

export function getEnabledTools() {
    const s = getEffectiveSettings();
    if (!s.toolsEnabled) return [];
    // Lorebook tools are part of the lorebook AI feature: the manage toggle
    // must gate them, not just the lorebook-changes prompt instructions.
    const lorebookGated = new Set(['search_lorebook_entry', 'get_lorebooks']);
    return TOOL_DEFINITIONS.filter(t => {
        if (lorebookGated.has(t.name) && s.lorebookAIManageEnabled === false) return false;
        return s[t.settingKey] !== false;
    });
}

// Normalizes raw provider payloads into a compact {title,url,snippet} list so the
// model sees one format regardless of provider and the result budget isn't wasted
// on provider metadata. Field mappings verified against Extension-WebSearch parsers.
const SEARCH_SNIPPET_MAX = 300;
const SEARCH_RESULTS_MAX = 10;

function normalizeSearchResults(provider, data) {
    let items = [];
    let answer = null;
    if (provider === 'serper' && Array.isArray(data.organic)) {
        items = data.organic.map(x => ({ title: x.title, url: x.link, snippet: x.snippet }));
    } else if (provider === 'serpapi' && Array.isArray(data.organic_results)) {
        items = data.organic_results.map(x => ({ title: x.title, url: x.link, snippet: x.snippet }));
    } else if (provider === 'tavily' && Array.isArray(data.results)) {
        answer = typeof data.answer === 'string' ? data.answer : null;
        items = data.results.map(x => ({ title: x.title, url: x.url, snippet: x.content }));
    } else if (provider === 'zai' && Array.isArray(data.search_result)) {
        items = data.search_result.map(x => ({ title: x.title, url: x.link, snippet: x.content }));
    } else {
        return null; // searxng (HTML) and unknown shapes stay raw
    }
    items = items
        .filter(x => x.url || x.title)
        .slice(0, SEARCH_RESULTS_MAX)
        .map(x => ({ ...x, snippet: String(x.snippet || '').slice(0, SEARCH_SNIPPET_MAX) }));
    return { items, answer };
}

export async function executeTool(toolName, toolInput) {
    const ctx = SillyTavern.getContext();
    switch (toolName) {
        case 'search_chat': {
            const msgs = ctx.chat || [];
            // Same visibility contract as roleplay_context assembly.
            const incHidden = !!getEffectiveSettings().includeHiddenMessages;
            let rawQueries = Array.isArray(toolInput.queries) ? toolInput.queries : (Array.isArray(toolInput.query) ? toolInput.query : [toolInput.query || '']);
            const parsedQueries = rawQueries.map(q => {
                const s = String(q);
                const regexMatch = s.match(/^\/(.+)\/([gimsuy]*)$/);
                if (regexMatch) {
                    try { return { type: 'regex', re: new RegExp(regexMatch[1], regexMatch[2]) }; } catch(_) {}
                }
                return { type: 'text', lq: s.toLowerCase() };
            });
            const role = toolInput.role || 'all';
            const fromIdx = toolInput.from_index ?? 0;
            const toIdx = toolInput.to_index ?? msgs.length - 1;
            const maxResults = Math.min(toolInput.max_results ?? 10, 50);
            const includeContent = toolInput.include_content !== false;

            const results = [];
            for (let i = Math.max(0, fromIdx); i <= Math.min(msgs.length - 1, toIdx); i++) {
                const m = msgs[i];
                if (isMsgHidden(m, incHidden)) continue;
                if (role === 'user' && !m.is_user) continue;
                if (role === 'assistant' && m.is_user) continue;
                const text = m.mes || '';
                
                let matched = false;
                for (const pq of parsedQueries) {
                    if (pq.type === 'regex' && pq.re) {
                        pq.re.lastIndex = 0;
                        if (pq.re.test(text)) { matched = true; break; }
                    } else {
                        if (text.toLowerCase().includes(pq.lq)) { matched = true; break; }
                        const tokens = pq.lq.split(/\s+/).filter(Boolean);
                        if (tokens.length > 1 && tokens.every(t => text.toLowerCase().includes(t))) { matched = true; break; }
                    }
                }
                
                if (matched) {
                    const entry = { index: i, role: m.is_user ? 'user' : 'assistant', name: m.name || (m.is_user ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')) };
                    if (includeContent) entry.content = text.length > 500 ? text.slice(0, 500) + '...[truncated]' : text;
                    results.push(entry);
                    if (results.length >= maxResults) break;
                }
            }
            return { found: results.length, results, note: `Use 'index' values in chat-changes proposals. Total messages searched: ${Math.min(msgs.length - 1, toIdx) - Math.max(0, fromIdx) + 1}` };
        }
        case 'search_lorebook_entry': {
            const activeBooks = getActiveLorebookNames();
            const lbSettings = getEffectiveSettings();
            let rawQueries = Array.isArray(toolInput.queries) ? toolInput.queries : (Array.isArray(toolInput.query) ? toolInput.query : [toolInput.query || '']);
            const parsedQueries = rawQueries.map(q => {
                const s = String(q);
                const regexMatch = s.match(/^\/(.+)\/([gimsuy]*)$/);
                if (regexMatch) {
                    try { return { type: 'regex', re: new RegExp(regexMatch[1], regexMatch[2]) }; } catch(_) {}
                }
                return { type: 'text', lq: s.toLowerCase() };
            });
            
            const targetBook = toolInput.book_name;
            const searchIn = toolInput.search_in || 'all';
            const onlyConstant = !!toolInput.only_constant;
            const onlyOutlet = !!toolInput.only_outlet;
            // full=true: модель обязана видеть точный текст перед правкой (якоря дословные).
            const fullContent = !!toolInput.full;
            const results = [];
            for (const bookName of activeBooks) {
                if (!isBookVisibleToTools(bookName, lbSettings)) continue;
                if (targetBook && !bookName.toLowerCase().includes(targetBook.toLowerCase())) continue;
                const data = await fetchWorldInfoBook(bookName).catch(() => null);
                if (!data) continue;
                for (const entry of wiEntriesToArray(data)) {
                    if (!isEntryVisibleToTools(bookName, entry, lbSettings)) continue;
                    const outletField = (entry.outlet || entry.outlet_name || entry.outletName || entry.automation_id || entry.automationId || '').trim();
                    const isOutletPos = String(entry.position) === '7' || String(entry.position).toLowerCase() === 'outlet';
                    const isEntryOutlet = isOutletPos || outletField !== '';
                    if (onlyConstant && !entry.constant) continue;
                    if (onlyOutlet && !isEntryOutlet) continue;
                    
                    const name = (entry.comment || '');
                    const keys = (entry.key || []).join(' ');
                    const text = (entry.content || '');
                    
                    let matched = false;
                    for (const pq of parsedQueries) {
                        if (pq.type === 'regex' && pq.re) {
                            pq.re.lastIndex = 0;
                            if (searchIn === 'all') {
                                matched = pq.re.test(name) || pq.re.test(keys) || pq.re.test(text);
                            } else if (searchIn === 'name') {
                                matched = pq.re.test(name);
                            } else if (searchIn === 'keys') {
                                matched = pq.re.test(keys);
                            } else if (searchIn === 'content') {
                                matched = pq.re.test(text);
                            }
                        } else {
                            const lq = pq.lq;
                            const lname = name.toLowerCase();
                            const lkeys = keys.toLowerCase();
                            const ltext = text.toLowerCase();
                            if (searchIn === 'all') {
                                matched = lname.includes(lq) || lkeys.includes(lq) || ltext.includes(lq);
                            } else if (searchIn === 'name') {
                                matched = lname.includes(lq);
                            } else if (searchIn === 'keys') {
                                matched = lkeys.includes(lq);
                            } else if (searchIn === 'content') {
                                matched = ltext.includes(lq);
                            }
                        }
                        if (matched) break;
                    }
                    
                    if (matched) {
                        const result = {
                            book: getDisplayName(bookName),
                            uid: entry.uid,
                            name: entry.comment || `Entry #${entry.uid}`,
                            keys: entry.key || [],
                            is_constant: !!entry.constant,
                            is_outlet: isEntryOutlet,
                            outlet_name: outletField || null,
                            disabled: !!entry.disable,
                        };
                        if (fullContent) result.content = entry.content || '';
                        else result.content_preview = (entry.content || '').slice(0, 200) + ((entry.content || '').length > 200 ? '...[truncated — pass full:true for exact text]' : '');
                        results.push(result);
                    }
                    if (results.length >= 20) break;
                }
                if (results.length >= 20) break;
            }
            return { found: results.length, results };
        }
        case 'get_lorebooks': {
            const lbSettings = getEffectiveSettings();
            const activeBooks = getActiveLorebookNames().filter(n => isBookVisibleToTools(n, lbSettings));
            const includeEntries = !!toolInput.include_entries;
            const specificBook = toolInput.book_name;
            if (!includeEntries) {
                return {
                    lorebooks: activeBooks.map(name => ({ name: getDisplayName(name), internal_name: name })),
                    total: activeBooks.length,
                };
            }
            // Same fuzzy match as search_lorebook_entry; exact matches preferred implicitly.
            const booksToProcess = specificBook
                ? activeBooks.filter(n => bookNameEq(n, specificBook) || bookNameEq(getDisplayName(n), specificBook)
                    || n.toLowerCase().includes(specificBook.toLowerCase())
                    || getDisplayName(n).toLowerCase().includes(specificBook.toLowerCase()))
                : activeBooks;
            if (specificBook && !booksToProcess.length) {
                return { error: `No active lorebook matches "${specificBook}". Active lorebooks: ${activeBooks.map(b => getDisplayName(b)).join(', ') || 'none'}. Call get_lorebooks without book_name to list them.` };
            }
            const result = {};
            for (const name of booksToProcess) {
                const data = await fetchWorldInfoBook(name).catch(() => null);
                if (!data) { result[getDisplayName(name)] = []; continue; }
                result[getDisplayName(name)] = wiEntriesToArray(data)
                    .filter(e => isEntryVisibleToTools(name, e, lbSettings))
                    .map(e => {
                    const outletField = (e.outlet || e.outlet_name || e.outletName || e.automation_id || e.automationId || '').trim();
                    const isOutletPos = String(e.position) === '7' || String(e.position).toLowerCase() === 'outlet';
                    return {
                        name: e.comment || `#${e.uid}`,
                        uid: e.uid,
                        is_constant: !!e.constant,
                        is_outlet: isOutletPos || outletField !== '',
                        outlet_name: outletField || null,
                        disabled: !!e.disable,
                    };
                });
            }
            return { lorebooks: result };
        }
        case 'ask_user': {
            return { __ask_user: true, question: toolInput.question, context: toolInput.context };
        }
        case 'read_url': {
            const url = String(toolInput.url || '').trim();
            if (!/^https?:\/\//i.test(url)) return { error: 'A full http(s) URL is required.' };
            const res = await fetch('/api/search/visit', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ url }),
            });
            if (!res.ok) return { error: `Failed to fetch the page (HTTP ${res.status}). The site may block bots or require JS.` };
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,header,form').forEach(el => el.remove());
            const text = (doc.body?.innerText || doc.body?.textContent || '')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            const max = Math.min(toolInput.max_chars ?? 6000, 20000);
            return {
                url,
                title: doc.title || null,
                total_length: text.length,
                text: text.length > max ? text.slice(0, max) + '…[truncated — increase max_chars or read the page in parts]' : text,
            };
        }
        case 'search_web': {
            const provider = String(toolInput.provider || 'zai');
            const query = String(toolInput.query || '').trim();
            if (!query) return { error: 'Empty search query.' };
            const bodies = {
                zai: { query },
                tavily: { query },
                serper: { query },
                serpapi: { query },
                searxng: { baseUrl: toolInput.searxng_url, query },
            };
            const body = bodies[provider];
            if (!body) return { error: `Unknown provider: ${provider}.` };
            if (provider === 'searxng' && !body.baseUrl) return { error: 'provider=searxng requires the searxng_url parameter.' };
            const res = await fetch(`/api/search/${provider}`, {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (res.status === 400) return { error: `Provider ${provider} is not configured: add an API key in ST (Secrets) or choose another provider.` };
            if (!res.ok) return { error: `Search failed (HTTP ${res.status}).` };
            const raw = await res.text();
            let parsed;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
            const norm = parsed !== null ? normalizeSearchResults(provider, parsed) : null;
            if (norm) {
                // Drop tail results instead of cutting the JSON string mid-token.
                let results = norm.items;
                while (results.length > 1 && JSON.stringify(results).length > 3800) results = results.slice(0, -1);
                const trimmed = norm.items.length - results.length;
                return {
                    provider, query, results,
                    ...(norm.answer ? { answer: norm.answer } : {}),
                    ...(trimmed ? { note: `${trimmed} results trimmed — refine the query or use read_url` } : {}),
                };
            }
            const payload = parsed !== null && raw.length > 4000 ? raw.slice(0, 4000) + '…[truncated]' : (parsed ?? raw);
            return { provider, query, results: payload };
        }
        case 'todo_write': {
            const todos = Array.isArray(toolInput.todos) ? toolInput.todos : [];
            // ponytail: план живёт в карточке тула (input+result); отдельная панель — когда запросят
            state.agentTodos = todos.map(t => ({ content: String(t.content || ''), status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending' }));
            const done = state.agentTodos.filter(t => t.status === 'completed').length;
            return { ok: true, progress: `${done}/${state.agentTodos.length}`, todos: state.agentTodos };
        }
        case 'get_char_info': {
            const charInfoFull = getCharInfo();
            if (!charInfoFull) return { error: 'No active character.' };
            const charCtx = ctx.characters?.[ctx.characterId];
            const requestedFields = toolInput.fields || ['description', 'personality', 'scenario'];
            const result = { name: charInfoFull.name };
            for (const f of requestedFields) {
                if (f === 'tags') result.tags = getTagsForCharacter(charCtx);
                else if (f === 'alternate_greetings') result.alternate_greetings = (charCtx?.data?.alternate_greetings || []);
                else result[f] = (charInfoFull[f] || charCtx?.data?.[f] || '');
            }
            return result;
        }
        case 'get_chat_stats': {
            const incHidden = !!getEffectiveSettings().includeHiddenMessages;
            const msgs = (ctx.chat || []).filter(m => !isMsgHidden(m, incHidden));
            const userMsgs = msgs.filter(m => m.is_user);
            const asMsgs = msgs.filter(m => !m.is_user);
            const totalChars = msgs.reduce((s, m) => s + (m.mes || '').length, 0);
            return {
                total_messages: msgs.length,
                user_messages: userMsgs.length,
                assistant_messages: asMsgs.length,
                approx_tokens: Math.ceil(totalChars / 3.5),
                first_message_index: 0,
                last_message_index: msgs.length - 1,
                char_name: ctx.name2 || 'Character',
                user_name: ctx.name1 || 'User',
            };
        }
        case 'get_recent_messages': {
            const incHidden = !!getEffectiveSettings().includeHiddenMessages;
            const count = Math.min(toolInput.count ?? 10, 50);
            const fromEnd = toolInput.from_end !== false;
            const role = toolInput.role || 'all';
            // full=true: модель обязана видеть точный текст перед правкой (якоря дословные).
            const maxLen = toolInput.full ? 20000 : 600;
            let filtered = (ctx.chat || []).map((m, i) => ({ ...m, _idx: i })).filter(m => !isMsgHidden(m, incHidden));
            if (role === 'user') filtered = filtered.filter(m => m.is_user);
            if (role === 'assistant') filtered = filtered.filter(m => !m.is_user);
            if (fromEnd) filtered = filtered.slice(-count);
            else filtered = filtered.slice(0, count);
            return {
                messages: filtered.map(m => ({
                    index: m._idx,
                    role: m.is_user ? 'user' : 'assistant',
                    name: m.name || (m.is_user ? (ctx.name1 || 'User') : (ctx.name2 || 'Character')),
                    send_date: m.send_date ?? null,
                    content: (m.mes || '').length > maxLen ? m.mes.slice(0, maxLen) + '...[truncated — request full=true]' : (m.mes || ''),
                })),
                note: 'Use "index" values in chat-changes proposals for precise targeting, and copy each message\'s send_date into msg_date/msg_dates so the edit is skipped if the chat shifted.',
            };
        }
        default: return { error: `Unknown tool: ${toolName}` };
    }
}

export function toOpenAITools() {
    return getEnabledTools().map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
    }));
}

// Error taxonomy for tool results (model-facing): a raw error.message gives the
// model a stack or an empty "an error occurred" to build its answer from. The
// kind also keeps unprovable failures (network/CORS/abort) from being reported
// as "the tool is broken" — their outcome is unknown, not negative.
export function classifyToolError(err) {
    const msg = String(err?.message || err || '');
    if (err?.name === 'AbortError' || msg.includes('Generation stopped by user')) {
        return { kind: 'stopped', userMessage: 'Generation stopped by user.' };
    }
    if (/did not respond within/i.test(msg)) {
        return { kind: 'timeout', userMessage: 'The tool did not respond in time. Its result is unknown — retry later or ask the user.' };
    }
    if (err instanceof TypeError && /fetch|network/i.test(msg)) {
        return { kind: 'network-unknown', userMessage: 'Network error while running the tool — the result is unknown, not a tool failure. Retrying may succeed.' };
    }
    const status = msg.match(/(?:Custom )?API Error (\d{3})/);
    if (status) {
        return { kind: 'provider-error', userMessage: `Provider returned HTTP ${status[1]} for this tool call. The tool itself is intact — retry or continue without its result.` };
    }
    if (err instanceof SyntaxError || /json/i.test(msg)) {
        return { kind: 'parse', userMessage: 'The tool returned an unparseable result. Try again with narrower arguments.' };
    }
    return { kind: 'unknown', userMessage: `Tool failed: ${msg.slice(0, 160)}` };
}


export function buildToolCallsSystemBlock() {
    const tools = getEnabledTools();
    if (!tools.length) return '';
    const s = getSettings();
    
    const formatSchemaProps = (properties) => {
        if (!properties || Object.keys(properties).length === 0) return '{}';
        const lines = [];
        for (const [key, prop] of Object.entries(properties)) {
            lines.push(`"${key}": ${JSON.stringify(prop)}`);
        }
        return `{${lines.join(',\n    ')}}`;
    };

    const toolsList = tools.map(t =>
        `- **${t.name}**: ${t.description} | Params: ${formatSchemaProps(t.schema.properties)}`
    ).join("\n");
    
    let prompt = s.toolsSystemPrompt || DEFAULT_TOOLS_PROMPT;
    if (!prompt.includes('{{tools_list}}')) {
        prompt += '\n\nTools available:\n{{tools_list}}';
    }
    if (!prompt.includes('{{tool_call_format}}')) {
        prompt = prompt.replace('Format requirement:', 'Format requirement:\n{{tool_call_format}}');
    }
    
    const finalPrompt = prompt
        .replace('{{tools_list}}', toolsList)
        .replace('{{tool_call_format}}', TOOL_CALL_FORMAT_BLOCK);

    // Contract guarantee: a custom tools prompt may omit the fence format; the
    // text-protocol parser depends on it, so the block is appended when missing.
    const contract = finalPrompt.includes('```tool_call')
        ? ''
        : '\n\nOutput requirement: emit every tool call ONLY as this fenced block, then stop:\n' + TOOL_CALL_FORMAT_BLOCK;

    return '\n\n' + _ensureWrapped(finalPrompt + contract, 'tool_calls_system');
}