import { EXT_DISPLAY, I, THEME_PRESETS } from '../constants.js';
import { state } from '../state.js';
import { getSettings, saveSettings, getCurrentSession, saveSessionsToMetadata, deleteMsg, truncateAfter, truncateFrom, expandMacros, getEffectiveSettings, getBindingKey, initChatBucket, isMessageStarred, toggleStarMessage } from '../session.js';
import { _dbgAdd } from '../utils/util-debug.js';
import { escHtml, autoResize, showCustomDialog, copyText } from '../utils/util-dom.js';
import { getCharInfo } from '../utils/util-st.js';

import { parseLBChangesFromText, stripLBChangesBlock } from '../features/feature-lorebook-engine.js';
import { renderProposalCard, appendLBHistoryEl } from '../features/feature-lorebook-ui.js';
import { parseCharChangesFromText, stripCharChangesBlock, parseCharCreationFromText, stripCharCreationBlock } from '../features/feature-character-engine.js';
import { renderCharProposalCard, renderCharCreationCard } from '../features/feature-character-ui.js';
import { normalizeCharNamesInBlock } from '../utils/util-text.js';
import { cacheKey } from '../utils/util-hash.js';
import { discoverProposalBlocks } from '../utils/util-block-discovery.js';
import { createStreamRenderer } from './render/stream-renderer.js';
import { computeRenderFrom } from './render/render-window.js';
import { parseChatChangesFromText, stripChatChangesBlock } from '../features/feature-chatedit-engine.js';
import { renderChatProposalCard } from '../features/feature-chatedit-ui.js';
import { stripMemoryBlock } from '../features/feature-memory.js';
import { parseToolCallsFromText } from '../features/feature-tools-engine.js';
import { postProcessToolCalls } from '../features/feature-tools-ui.js';
import { recordStat, SM } from '../features/feature-stats.js';
import { _openImageLightbox, _openTextLightbox } from '../features/feature-attachments.js';

import { apiMod, uiWinMod, uiWdgMod, uiSetMod, featCharUiMod } from './chat-shared.js';
import { getSwipesForMsg, navigateSwipe, updateSwipeBar, _runSwipeRegen, setupCodeBlockActions } from './msg-actions.js';
import { updateMsgCount } from './session-view.js';
// ─── Text Render and Markdown ────────────────────────────────────────────────

export function renderMarkdown(text) {
    const codeBlocks = [];
    const pushCodeBlock = (lang, code) => {
        const i = codeBlocks.length;
        const escaped = code.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const langAttr = lang ? ` lang-${lang}` : '';
        // Тулбар — чистый HTML, а не DOM-элемент: .scp-msg-content перезаписывается
        // через innerHTML на каждом чанке стрима, поэтому обработчик клика живёт
        // делегированно на #scp-messages (см. setupCodeBlockActions).
        codeBlocks.push(
            `<div class="scp-code-block-wrap${langAttr}">`
            + `<div class="scp-code-toolbar">`
            + `<span class="scp-code-lang">${escHtml(lang ? lang.toLowerCase() : 'код')}</span>`
            + `<button type="button" class="scp-code-copy-btn" title="Копировать код">${I.copy}<span>Копировать</span></button>`
            + `</div>`
            + `<pre class="scp-code-block${langAttr}"><code>${escaped}</code></pre>`
            + `</div>`
        );
        return `\x00B${i}\x00`;
    };
    let out = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        if (lang && lang.toLowerCase() === 'html') {
            const id = `scp-hb-${state.htmlBlockCounter++}`;
            state.htmlBlockRegistry.set(id, code.trim());
            // Страховка от утечки: записи, которые никогда не будут потреблены
            // postProcessHTMLBlocks (прерванный рендер), не должны жить вечно.
            if (state.htmlBlockRegistry.size > 400) {
                state.htmlBlockRegistry.delete(state.htmlBlockRegistry.keys().next().value);
            }
            return `\x00H${id}\x00`;
        }
        return pushCodeBlock(lang, code);
    });

    // Незакрытый фенс в хвосте (стрим оборвался / оборвали на стриме): рендерим
    // как код-блок до конца текста, иначе сырой маркер ``` висит в сообщении.
    // html-фенс тут сознательно НЕ исполняется: частичный скрипт запускать нельзя.
    if (/```/.test(out)) {
        out = out.replace(/```(\w*)\n?([\s\S]*)$/, (_, lang, code) => pushCodeBlock(lang, code));
    }

    out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out = out.replace(/`([^`\n]+)`/g, '<code class="scp-inline-code">$1</code>');

    const applyInline = (s) => {
        let res = s;
        res = res.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        res = res.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        res = res.replace(/~~(.+?)~~/g, '<del>$1</del>');
        res = res.replace(/\*([^<>\*\n]+)\*/g, '<em>$1</em>');
        return res;
    };

    const lines = out.split('\n');

    const getULIndent = (l) => { const m = l.match(/^(\s*)[*\-+]\s+\S/); return m ? m[1].length : -1; };
    const getOLIndent = (l) => { const m = l.match(/^(\s*)\d+\.\s+\S/); return m ? m[1].length : -1; };
    const isListLine = (l) => getULIndent(l) >= 0 || getOLIndent(l) >= 0;

    const buildNestedList = (listLines) => {
        const stack = [];
        let r = '';
        const closeUntil = (targetIndent, targetType) => {
            while (stack.length) {
                const top = stack[stack.length - 1];
                if (top.indent > targetIndent || (top.indent === targetIndent && top.type !== targetType)) {
                    r += `</li></${top.type}>`;
                    stack.pop();
                } else {
                    break;
                }
            }
        };
        for (let line of listLines) {
            if (!line.trim()) continue;
            if (!isListLine(line)) {
                r += `<br>${applyInline(line.trim())}`;
                continue;
            }
            const ulI = getULIndent(line);
            const olI = getOLIndent(line);
            const indent = ulI >= 0 ? ulI : olI;
            const type = ulI >= 0 ? 'ul' : 'ol';
            const cls = `scp-list${type === 'ol' ? ' scp-list-ol' : ''}`;
            
            let content = type === 'ul'
                ? line.replace(/^\s*[*\-+]\s+/, '')
                : line.replace(/^\s*\d+\.\s+/, '');
            
            content = applyInline(content);
            closeUntil(indent, type);
            
            if (stack.length && stack[stack.length - 1].indent === indent && stack[stack.length - 1].type === type) {
                r += `</li><li>${content}`;
            } else {
                r += `<${type} class="${cls}"><li>${content}`;
                stack.push({ indent, type });
            }
        }
        while (stack.length) r += `</li></${stack.pop().type}>`;
        return r;
    };

    const segs = [];
    const pushBlock = (h) => segs.push({ t: 'block', h });
    const pushInline = (h) => segs.push({ t: 'inline', h });

    let listBuf = [];
    let tableRows = [];
    let bqLines = [];

    const flushList = () => {
        if (!listBuf.length) return;
        pushBlock(buildNestedList(listBuf));
        listBuf = [];
    };
    const flushTable = () => {
        if (!tableRows.length) return;
        pushBlock(`<div class="scp-table-wrap"><table class="scp-table"><tbody>${tableRows.join('')}</tbody></table></div>`);
        tableRows = [];
    };
    const flushBq = () => {
        if (!bqLines.length) return;
        pushBlock(`<blockquote class="scp-blockquote">${bqLines.join('<br>')}</blockquote>`);
        bqLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimLine = line.trim();

        if (/^(---+|\*\*\*+|___+)$/.test(trimLine)) {
            flushList(); flushTable(); flushBq();
            pushBlock('<hr class="scp-hr">');
            continue;
        }

        const hm = line.match(/^(#{1,6})\s+(.+)/);
        if (hm) {
            flushList(); flushTable(); flushBq();
            pushBlock(`<span class="scp-h${hm[1].length}">${applyInline(hm[2])}</span>`);
            continue;
        }

        const bq = line.match(/^&gt;\s*(.*)/);
        if (bq) { flushList(); flushTable(); bqLines.push(applyInline(bq[1])); continue; }

        const tm = trimLine.match(/^\|(.*)\|$/);
        if (tm) {
            flushList(); flushBq();
            if (/^[|\s\-:]+$/.test(trimLine)) continue;
            const cells = tm[1].split('|').map(c => applyInline(c.trim()));
            const tag = tableRows.length === 0 ? 'th' : 'td';
            tableRows.push(`<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join('')}</tr>`);
            continue;
        }

        if (isListLine(line)) {
            flushTable(); flushBq();
            listBuf.push(line);
            continue;
        }

        if (listBuf.length > 0 && trimLine && /^\s+/.test(line)) {
            listBuf.push(line);
            continue;
        }

        if (!trimLine) {
            let nextNonEmpty = '';
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim()) { nextNonEmpty = lines[j]; break; }
            }
            if (nextNonEmpty && isListLine(nextNonEmpty)) {
                listBuf.push('');
            } else {
                flushList(); flushTable(); flushBq();
                pushInline('');
            }
            continue;
        }

        flushList(); flushTable(); flushBq();
        pushInline(applyInline(line));
    }
    flushList(); flushTable(); flushBq();

    let result = '';
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.t === 'inline' && i > 0 && segs[i - 1].t === 'inline') result += '<br>';
        result += seg.h;
    }
    out = result;

    out = out.replace(/\x00H(scp-hb-\d+)\x00/g, (_, id) => `<div class="scp-html-block-ph" data-hbid="${id}"></div>`);
    out = out.replace(/\x00B(\d+)\x00/g, (_, i) => codeBlocks[+i]);
    out = out.replace(/\x00TC_(\d+)\x00/g, (_, i) => `<div class="scp-tool-call-ph" data-tcid="${i}"></div>`);
    out = out.replace(/(<div class="scp-tool-call-ph"[^>]*><\/div>)(?:<br>|\s)*/g, '$1');

    return out;
}

export function prepareHtmlForIframe(code) {
    const cs = `<script>(function(){
function isTransparent(c){return !c||c==='transparent'||c==='rgba(0, 0, 0, 0)'||c==='rgba(0,0,0,0)';}
function hasVisualBg(el){
if(!el) return false;
var cs=window.getComputedStyle(el);
if(!isTransparent(cs.backgroundColor)) return true;
if(cs.backgroundImage&&cs.backgroundImage!=='none') return true;
return false;
}
function applyFallbackTheme(){
var b=document.body,d=document.documentElement;
var hasBg=false;
if(hasVisualBg(d)||hasVisualBg(b)) hasBg=true;
if(!hasBg){
    var styled=document.querySelectorAll('[style]');
    for(var i=0;i<styled.length;i++){if(hasVisualBg(styled[i])){hasBg=true;break;}}
}
if(!hasBg){
    var styleText='';
    var styleEls=document.querySelectorAll('style');
    for(var j=0;j<styleEls.length;j++) styleText+=styleEls[j].textContent;
    if(/(?:body|html|:root)\s*\{[^}]*background/i.test(styleText)) hasBg=true;
}
if(!hasBg){
    b.style.backgroundColor='#ffffff';
    b.style.color='#1a1a1a';
    window.parent.postMessage({type:'scp-iframe-bg',hasBg:false},'*');
} else {
    window.parent.postMessage({type:'scp-iframe-bg',hasBg:true},'*');
}
}
function sh(){var b=document.body,d=document.documentElement;var h=Math.max(b?b.scrollHeight:0,b?b.offsetHeight:0,d.scrollHeight,d.offsetHeight);window.parent.postMessage({type:'scp-iframe-h',h:h},'*');}
window.addEventListener('load',function(){
applyFallbackTheme();
sh();setTimeout(sh,150);setTimeout(sh,500);
if(window.ResizeObserver&&document.body){new ResizeObserver(sh).observe(document.body);}
else{var t;try{new MutationObserver(function(){clearTimeout(t);t=setTimeout(sh,80);}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});}catch(e){}}
});
window.onerror=function(m){window.parent.postMessage({type:'scp-iframe-err',msg:String(m)},'*');return true;};
})();<\/script>`;
    const hasHtml = /<html[\s>]/i.test(code);
    if (hasHtml) {
        return /<\/body>/i.test(code) ? code.replace(/<\/body>/i, cs + '</body>') : code + cs;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;padding:4px;font-family:system-ui,sans-serif;background:transparent}</style></head><body>${code}${cs}</body></html>`;
}

export function createHTMLBlockEl(code) {
    const wrap = document.createElement('div');
    wrap.className = 'scp-html-block';

    const toolbar = document.createElement('div');
    toolbar.className = 'scp-html-block-toolbar';
    const label = document.createElement('span');
    label.className = 'scp-html-block-label';
    label.textContent = 'HTML';
    const previewBtn = document.createElement('button');
    previewBtn.className = 'scp-html-block-btn active';
    previewBtn.textContent = 'Просмотр';
    const codeBtn = document.createElement('button');
    codeBtn.className = 'scp-html-block-btn';
    codeBtn.textContent = 'Код';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'scp-html-block-btn';
    copyBtn.textContent = 'Копировать';
    copyBtn.addEventListener('click', e => { e.stopPropagation(); copyText(code); });
    toolbar.append(label, previewBtn, codeBtn, copyBtn);

    const errorEl = document.createElement('div');
    errorEl.className = 'scp-html-block-error';
    errorEl.style.display = 'none';

    const iframe = document.createElement('iframe');
    iframe.className = 'scp-html-block-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock allow-downloads');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = prepareHtmlForIframe(code);

    const codePre = document.createElement('pre');
    codePre.className = 'scp-code-block scp-html-block-code';
    codePre.style.display = 'none';
    codePre.textContent = code;

    previewBtn.addEventListener('click', () => {
        iframe.style.display = '';
        codePre.style.display = 'none';
        previewBtn.classList.add('active');
        codeBtn.classList.remove('active');
    });
    codeBtn.addEventListener('click', () => {
        iframe.style.display = 'none';
        codePre.style.display = '';
        codeBtn.classList.add('active');
        previewBtn.classList.remove('active');
    });

    wrap.append(toolbar, errorEl, iframe, codePre);
    return wrap;
}

export function postProcessHTMLBlocks(el) {
    el.querySelectorAll('.scp-html-block-ph').forEach(ph => {
        const code = state.htmlBlockRegistry.get(ph.dataset.hbid);
        if (code !== undefined) {
            // Запись читается ровно один раз для своего плейсхолдера — удаляем,
            // чтобы реестр не рос с каждым стрим-рендером.
            state.htmlBlockRegistry.delete(ph.dataset.hbid);
            ph.replaceWith(createHTMLBlockEl(code));
        }
    });
}

export function getDisplayContent(rawText, settings) {
    let text = rawText;
    const trimLines = (settings.reasoningTrimStrings || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const ts of trimLines) text = text.split(ts).join('');
    
    const pats = [/<think>([\s\S]*?)<\/think>/i, /<thinking>([\s\S]*?)<\/thinking>/i];
    let reasoning = null;
    for (const p of pats) {
        const m = text.match(p);
        if (m) { reasoning = m[1].trim() || null; text = text.replace(m[0], '').trim(); break; }
    }
    return { reasoning, content: text };
}

export function extractToolCallPlaceholders(text, startIndex = 0) {
    let tcIndex = startIndex;
    let result = text;
    
    result = result.replace(/```tool_call\n?([\s\S]*?)```/gi, (match, inner) => {
        const blockTcs = parseToolCallsFromText(`\`\`\`tool_call\n${inner}\n\`\`\``);
        let phs = '';
        const count = Math.max(1, blockTcs.length);
        for (let i = 0; i < count; i++) {
            phs += `\x00TC_${tcIndex++}\x00`;
        }
        return phs;
    });
    
    result = result.replace(/```tool_call\n?([\s\S]*)$/gi, (match, inner) => {
        const blockTcs = parseToolCallsFromText(`\`\`\`tool_call\n${inner}\n\`\`\``);
        let phs = '';
        const count = Math.max(1, blockTcs.length);
        for (let i = 0; i < count; i++) {
            phs += `\x00TC_${tcIndex++}\x00`;
        }
        return phs;
    });
    
    return { text: result, nextIndex: tcIndex };
}

// ─── Rendering messages ──────────────────────────────────────────────────────

export function _renderMsgBodyContent(msgEl, msg) {
    const settings = getSettings();
    msgEl.querySelectorAll('.scp-tool-call-item').forEach(c => c.remove());

    const cleanContent = stripMemoryBlock(msg.content);
    let displayText = cleanContent;
    let reasoning = msg.reasoning !== undefined ? (msg.reasoning || null) : null;

    // Плейсхолдеры нумеруем от КОНТЕНТА, не от reasoning: исполненные инструменты
    // (msg.toolCalls) соответствуют фенсам контента; fence, написанный моделью
    // в размышлениях, не должен уводить индекс и оставлять карточку пустой.
    let tcIndex = 0;
    const resC = extractToolCallPlaceholders(displayText, tcIndex);
    displayText = resC.text;
    tcIndex = resC.nextIndex;
    if (reasoning) {
        const resR = extractToolCallPlaceholders(reasoning, tcIndex);
        reasoning = resR.text;
        tcIndex = resR.nextIndex;
    }

    if (msg.reasoning === undefined || msg.reasoning === null) {
        const d = getDisplayContent(displayText, settings);
        reasoning = d.reasoning;
        displayText = d.content;
        if (msg.reasoning === undefined) msg.reasoning = reasoning;
    }

    const body = msgEl.querySelector('.scp-msg-body');
    if (!body) return;

    msgEl.querySelectorAll('.scp-lb-proposal-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-char-proposal-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-char-creation-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-chat-proposal-card').forEach(c => c.remove());
    msgEl.querySelectorAll('.scp-msg-hist-wrap').forEach(c => c.remove());

    let rBlock = msgEl.querySelector('.scp-reasoning-block');
    if (reasoning) {
        if (!rBlock) {
            rBlock = document.createElement('details');
            rBlock.className = 'scp-reasoning-block';
            rBlock.innerHTML = `<summary class="scp-reasoning-summary">Размышления</summary><div class="scp-reasoning-content"></div>`;
            body.insertBefore(rBlock, body.firstChild);
        }
        rBlock.style.display = '';
        rBlock.querySelector('.scp-reasoning-content').innerHTML = renderMarkdown(reasoning);
        postProcessHTMLBlocks(rBlock.querySelector('.scp-reasoning-content'));
    } else if (rBlock) {
        rBlock.remove();
    }

    const contentEl = msgEl.querySelector('.scp-msg-content');
    
    msgEl.querySelectorAll('.scp-msg-attachments').forEach(c => c.remove());
    if (msg.attachments && msg.attachments.length > 0) {
        const attWrap = document.createElement('div');
        attWrap.className = 'scp-msg-attachments';
        msg.attachments.forEach(att => {
            const badge = document.createElement('div');
            badge.className = 'scp-msg-att-badge';
            // dataUrl приходит из персистентных сессий (в т.ч. импортированных) —
            // только DOM API, никакой интерполяции в innerHTML.
            if (att.isImage) {
                const img = document.createElement('img');
                img.src = typeof att.dataUrl === 'string' && /^(data:|https?:|blob:)/i.test(att.dataUrl) ? att.dataUrl : '';
                img.alt = '';
                const span = document.createElement('span');
                span.textContent = att.name || '';
                badge.appendChild(img);
                badge.appendChild(document.createTextNode(' '));
                badge.appendChild(span);
                badge.onclick = () => _openImageLightbox(att);
            } else {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-file';
                const span = document.createElement('span');
                span.textContent = att.name || '';
                badge.appendChild(icon);
                badge.appendChild(document.createTextNode(' '));
                badge.appendChild(span);
                badge.onclick = () => _openTextLightbox(att);
            }
            attWrap.appendChild(badge);
        });
        body.insertBefore(attWrap, body.firstChild);
    }

    if (contentEl) {
        // Однопроходное обнаружение proposal-блоков: раньше тут всегда 4 парсера
        // падали в text regex'ами по ~16 сканов即使 когда блоков нет. Теперь один
        // лёгкий regex, затем вызываем только relevant парсеры.
        // Парсеры НЕ меняются — они возвращают распарсенный контент, а discovery лишь
        // решает, какие запускать. Это даёт 1 regex вместо 8-16 на типичном сообщении.
        const flags = discoverProposalBlocks(msg.content);
        const lbChanges = flags.lb ? parseLBChangesFromText(msg.content) : null;
        const charChanges = flags.char ? parseCharChangesFromText(msg.content) : null;
        const charCreation = flags.charCreate ? parseCharCreationFromText(msg.content) : null;
        const chatChanges = flags.chat ? parseChatChangesFromText(msg.content) : null;
        const needsStrip = lbChanges?.length || charChanges?.length || charCreation || chatChanges?.length;

        if (needsStrip) {
            let stripped = displayText;
            if (lbChanges?.length) stripped = stripLBChangesBlock(stripped);
            if (charChanges?.length) stripped = stripCharChangesBlock(stripped);
            if (charCreation) stripped = stripCharCreationBlock(stripped);
            if (chatChanges?.length) stripped = stripChatChangesBlock(stripped);
            
            contentEl.innerHTML = renderMarkdown(getDisplayContent(stripped, settings).content);
            postProcessHTMLBlocks(contentEl);
            
            if (lbChanges?.length) renderProposalCard(lbChanges, msgEl);
            if (charChanges?.length) renderCharProposalCard(charChanges, msgEl);
            if (charCreation) renderCharCreationCard(charCreation, msgEl);
            if (chatChanges?.length) renderChatProposalCard(chatChanges, msgEl);
        } else {
            contentEl.innerHTML = renderMarkdown(getDisplayContent(displayText, settings).content);
            postProcessHTMLBlocks(contentEl);
        }
    }

    const currentSwipe = msg.swipes?.[msg.swipeIndex || 0];
    if (currentSwipe?.historyLines?.length) {
        const hw = document.createElement('div');
        hw.className = 'scp-msg-hist-wrap';
        
        const cEl = document.createElement('div');
        cEl.className = 'scp-msg-content scp-lb-history-content';
        cEl.style.cssText = 'margin-top:10px; padding:8px 12px; background:var(--scp-accent-bg); border:1px solid var(--scp-accent-dim); border-radius:6px;';
        
        import('../features/feature-lorebook-ui.js').then(m => m.renderLBHistoryContent({ appliedLines: currentSwipe.historyLines }, cEl));

        hw.appendChild(cEl);
        
        const swipeBar = body.querySelector('.scp-swipe-bar');
        if (swipeBar) body.insertBefore(hw, swipeBar);
        else body.appendChild(hw);
    }

    _updateMsgTokenCount(msgEl, msg.content, true);

    let liveTCs = msg.toolCalls || [];
    if (!liveTCs.length && tcIndex > 0) {
        // Порядок обязан совпадать с нумерацией плейсхолдеров выше: сначала
        // контент, потом reasoning — иначе карточки встают не на свои места.
        liveTCs = parseToolCallsFromText((msg.content || '') + '\n' + (msg.reasoning || '')).map((tc, i) => ({
            id: `past_${i}`, name: tc.name, input: tc.input, status: 'done', result: 'Result hidden/expired'
        }));
    }
    if (liveTCs.length) {
        // Нативные tool-раунды не оставляют фенсов в тексте — плейсхолдеров нет,
        // синтезируем их в конец тела сообщения, иначе карточкам некуда встать.
        if (!msgEl.querySelector('.scp-tool-call-ph')) {
            const contentEl = msgEl.querySelector('.scp-msg-content');
            if (contentEl) {
                liveTCs.forEach((_, i) => {
                    const ph = document.createElement('div');
                    ph.className = 'scp-tool-call-ph';
                    ph.dataset.tcid = String(i);
                    contentEl.appendChild(ph);
                });
            }
        }
        postProcessToolCalls(msgEl, liveTCs);
    }
}

export function _updateMsgTokenCount(msgEl, content, forceRecalc = false) {
    const el = msgEl.querySelector ? msgEl.querySelector('.scp-msg-token-count') : null;
    if (!el) return;
    // Используем тот же хэш-ключ, что и estimateTokens — консистентность кэша.
    const key = cacheKey(content);
    if (!forceRecalc) {
        const cached = state.tokenCountCache.get(key);
        if (cached !== undefined) { el.textContent = `${cached}t`; return; }
    } else {
        el.textContent = '\u2026';
    }
    if (apiMod) {
        apiMod.estimateTokens(content).then(n => {
            // estimateTokens уже записал в кэш под тем же key — переписывать не нужно.
            if (el.isConnected) el.textContent = `${n}t`;
        });
    }
}

export function createMsgEl(msg, onCopy, onEdit, onDelete, onRegen) {
    const isUser = msg.role === 'user';
    const wrap = document.createElement('div');
    wrap.className = `scp-msg ${isUser ? 'scp-msg-user' : 'scp-msg-assistant'}`;
    wrap.dataset.id = msg.id;

    const header = document.createElement('div');
    header.className = 'scp-msg-header';

    const avatar = document.createElement('div');
    avatar.className = 'scp-msg-avatar';
    avatar.innerHTML = isUser ? I.user : I.bot;

    const meta = document.createElement('div');
    meta.className = 'scp-msg-meta';
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = msg.genStamp ? `${timeStr} · ${msg.genStamp}` : timeStr;
    if (msg.genStamp) meta.title = msg.genStamp;

    const tokenCountEl = document.createElement('div');
    tokenCountEl.className = 'scp-msg-token-count';
    tokenCountEl.textContent = '…';
    _updateMsgTokenCount({ querySelector: () => tokenCountEl, isConnected: true }, msg.content);

    const headerRight = document.createElement('div');
    headerRight.className = 'scp-msg-header-right';
    headerRight.appendChild(meta);
    headerRight.appendChild(tokenCountEl);

    header.appendChild(avatar);
    header.appendChild(headerRight);

    const body = document.createElement('div');
    body.className = 'scp-msg-body';

    const content = document.createElement('div');
    content.className = 'scp-msg-content';
    body.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'scp-msg-actions';

    const makeBtn = (icon, label, cls, cb) => {
        const b = document.createElement('button');
        b.className = `scp-msg-btn${cls ? ' ' + cls : ''}`;
        b.innerHTML = icon; b.title = label;
        b.addEventListener('click', cb);
        return b;
    };

    actions.appendChild(makeBtn(I.copy, 'Копировать', '', () => onCopy(msg)));
    actions.appendChild(makeBtn(I.edit, 'Изменить', '', () => onEdit(wrap, msg)));
    actions.appendChild(makeBtn(I.refresh, 'Перегенерировать', '', () => onRegen(wrap, msg)));
    actions.appendChild(makeBtn(I.trash, 'Удалить', 'scp-msg-btn-danger', () => onDelete(wrap, msg)));

    const isStarred = isMessageStarred(msg.id);
    const starBtn = makeBtn(isStarred ? I.starFill : I.star, isStarred ? 'Убрать из избранного' : 'В избранное', `scp-msg-btn-star${isStarred ? ' starred' : ''}`, () => {
        const nowStarred = toggleStarMessage(msg.id);
        starBtn.innerHTML = nowStarred ? I.starFill : I.star;
        starBtn.title = nowStarred ? 'Убрать из избранного' : 'В избранное';
        starBtn.classList.toggle('starred', nowStarred);
        wrap.classList.toggle('scp-msg-starred', nowStarred);
        if (document.getElementById('scp-fav-panel')?.style.display !== 'none' && uiWdgMod) {
            uiWdgMod.renderFavoritesPanel();
        }
    });
    actions.appendChild(starBtn);
    if (isStarred) wrap.classList.add('scp-msg-starred');

    if (!isUser) {
        const continueBtn = makeBtn(I.continueArrow, 'Продолжить ответ', 'scp-msg-btn-continue', () => {
            if (apiMod) apiMod.runContinue(getCurrentSession(), msg.id);
        });
        actions.appendChild(continueBtn);
    }

    body.appendChild(actions);

    if (!isUser) {
        const swipeBar = document.createElement('div');
        swipeBar.className = 'scp-swipe-bar';
        swipeBar.style.display = 'none';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'scp-swipe-btn scp-swipe-prev';
        prevBtn.innerHTML = I.chevronLeft;
        prevBtn.title = 'Предыдущий вариант';
        prevBtn.disabled = true;

        const counter = document.createElement('span');
        counter.className = 'scp-swipe-counter';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'scp-swipe-btn scp-swipe-next';
        nextBtn.innerHTML = I.chevronRight;
        nextBtn.title = 'Новый вариант (перегенерировать)';

        prevBtn.addEventListener('click', async () => {
            if (prevBtn.disabled || state.generating) return;
            if (wrap.classList.contains('is-editing')) { toastr.info('Сначала завершите редактирование сообщения.', EXT_DISPLAY); return; }
            const session = getCurrentSession();
            if (!getSwipesForMsg(session, msg.id)) return;
            
            const bdy = wrap.querySelector('.scp-msg-body');
            if (bdy) {
                bdy.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
                bdy.classList.add('scp-swipe-anim-out-right'); 
                await new Promise(r => setTimeout(r, 150));
            }
            
            if (navigateSwipe(session, msg.id, -1)) {
                if (bdy) {
                    bdy.classList.remove('scp-swipe-anim-out-right');
                    void bdy.offsetWidth;
                    bdy.classList.add('scp-swipe-anim-left'); 
                }
                _renderMsgBodyContent(wrap, session.messages.find(m => m.id === msg.id));
                updateSwipeBar(wrap, session, msg.id);
            }
        });

        nextBtn.addEventListener('click', async () => {
            if (nextBtn.disabled || state.generating) return;
            if (wrap.classList.contains('is-editing')) { toastr.info('Сначала завершите редактирование сообщения.', EXT_DISPLAY); return; }
            const session = getCurrentSession();
            const msgData = session.messages.find(m => m.id === msg.id);
            if (!msgData) return;
            
            if (msgData.swipeIndex !== undefined && msgData.swipeIndex < (msgData.swipes?.length || 1) - 1) {
                const bdy = wrap.querySelector('.scp-msg-body');
                if (bdy) {
                    bdy.classList.remove('scp-swipe-anim-right', 'scp-swipe-anim-left');
                    bdy.classList.add('scp-swipe-anim-out-left'); 
                    await new Promise(r => setTimeout(r, 150));
                }

                if (navigateSwipe(session, msg.id, 1)) {
                    if (bdy) {
                        bdy.classList.remove('scp-swipe-anim-out-left');
                        void bdy.offsetWidth;
                        bdy.classList.add('scp-swipe-anim-right'); 
                    }
                    _renderMsgBodyContent(wrap, session.messages.find(m => m.id === msg.id));
                    updateSwipeBar(wrap, session, msg.id);
                }
            } else {
                _dbgAdd('SWIPE_REGEN_TRIGGERED', { msgId: msg.id });
                _runSwipeRegen(session, msg.id, wrap);
            }
        });

        swipeBar.appendChild(prevBtn);
        swipeBar.appendChild(counter);
        swipeBar.appendChild(nextBtn);

        const delSwipeBtn = document.createElement('button');
        delSwipeBtn.className = 'scp-swipe-btn scp-swipe-del';
        delSwipeBtn.innerHTML = I.x;
        delSwipeBtn.title = 'Удалить текущий вариант ответа';
        delSwipeBtn.addEventListener('click', async () => {
            if (state.generating) return;
            if (wrap.classList.contains('is-editing')) { toastr.info('Сначала завершите редактирование сообщения.', EXT_DISPLAY); return; }
            const session = getCurrentSession();
            const msgData = session.messages.find(m => m.id === msg.id);
            if (!msgData || (msgData.swipes?.length || 1) < 2) return;
            const ok = await showCustomDialog({
                type: 'confirm',
                title: 'Удалить вариант',
                message: 'Удалить текущий вариант ответа? Остальные варианты сохранятся.'
            });
            if (!ok) return;
            msgData.swipes.splice(msgData.swipeIndex ?? 0, 1);
            msgData.swipeIndex = Math.min(msgData.swipeIndex ?? 0, msgData.swipes.length - 1);
            msgData.content = msgData.swipes[msgData.swipeIndex].content;
            msgData.reasoning = msgData.swipes[msgData.swipeIndex].reasoning || null;
            saveSessionsToMetadata();
            updateMsgCount(session);
            _renderMsgBodyContent(wrap, msgData);
            updateSwipeBar(wrap, session, msg.id);
        });
        swipeBar.appendChild(delSwipeBtn);
        body.appendChild(swipeBar);
    }

    wrap.appendChild(header); wrap.appendChild(body);
    _renderMsgBodyContent(wrap, msg);
    
    return wrap;
}

// ─── Swipes and Generation ──────────────────────────────────────────────────────

