// Инкрементальный рендер стриминга с RAF-throttling.
//
// Проблема: текущий onChunk (~50-100ms интервал) делает полный
//   streamContentEl.innerHTML = renderMarkdown(stripMemoryBlock(text))
// на суммарно растущем тексте. Для типового ответа в 2000 токенов это
// ~30-40 вызовов полного re-render → O(N²) work по общей длине.
//
// Решение: рендерить только дельту, добавляя в DOM новые абзацы по
// «безопасной границе» (paragraph / end of code-fence / end of list) и с
// throttling'ом через requestAnimationFrame. Визуальный результат идентичен:
// тот же Markdown, тот же текст, тот же курсор.
//
// `findSafeRenderBoundary` вынесен в отдельный модуль (`find-safe-boundary.js`),
// т.к. это pure function и должна unit-тестироваться без DOM-зависимостей.

import { renderMarkdown, postProcessHTMLBlocks } from '../ui-chat.js';
import { stripMemoryBlock } from '../../features/feature-memory.js';
import { findSafeRenderBoundary } from './find-safe-boundary.js';

// Re-export для удобства внешних импортёров и тестов.
export { findSafeRenderBoundary };

// ─── Потоковый рендерер ────────────────────────────────────────────────────────

/**
 * Создаёт stateful рендерер для одного стрима.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.el         — целевой .scp-msg-content
 * @param {(el:HTMLElement)=>void} [opts.onPostProcess] — вызывается после каждого flush
 *        (для postProcessHTMLBlocks или postProcessToolCalls). По умолчанию postProcessHTMLBlocks.
 * @param {()=>void} [opts.onScroll]    — вызывается после flush (smartScrollToBottom).
 * @param {boolean} [opts.preprocessed] — true, если push() получает уже display-текст
 *        (stripMemoryBlock применять не нужно): убирает полнотекстовый скан на каждый push.
 */
export function createStreamRenderer(opts = {}) {
    const el = opts.el || null;
    const onPostProcess = opts.onPostProcess || postProcessHTMLBlocks;
    const onScroll = opts.onScroll || (() => {});
    const preprocessed = !!opts.preprocessed;

    let targetEl = el;
    let renderedLen = 0;     // длина displayText, уже зафиксированная в DOM
    let pendingTail = '';   // displayText.slice(renderedLen)
    let lastFullDisplayText = ''; // кэш прошлого displayText для diff
    let rafScheduled = false;
    let cursorEl = null;
    let destroyed = false;

    function _scheduleFlush() {
        if (rafScheduled || destroyed) return;
        rafScheduled = true;
        // requestAnimationFrame может отсутствовать в тестовом окружении —
        // тогда используем microtask fallback (Promise).
        const schedule = (typeof requestAnimationFrame === 'function')
            ? requestAnimationFrame
            : (cb) => Promise.resolve().then(cb);
        schedule(() => {
            rafScheduled = false;
            _flush();
        });
    }

    function _flush() {
        if (destroyed || !targetEl) return;
        if (!pendingTail) return;

        // Курсор виден и пока хвост копится (граница ещё не найдена) —
        // иначе пустое сообщение в первые секунды стрима выглядит сломанным.
        if (cursorEl && !cursorEl.parentNode) targetEl.appendChild(cursorEl);

        const boundary = findSafeRenderBoundary(pendingTail);
        if (boundary < 0) {
            // копим ещё
            return;
        }

        const commitText = pendingTail.slice(0, boundary);
        pendingTail = pendingTail.slice(boundary);
        if (!commitText) return;

        // Рендерим commit-чанк: для первого блока заменяем innerHTML, далее append.
        if (renderedLen === 0) {
            targetEl.innerHTML = renderMarkdown(commitText);
        } else {
            // append: insertAdjacentHTML держит существующие узлы, дописывает в конец.
            targetEl.insertAdjacentHTML('beforeend', renderMarkdown(commitText));
        }
        renderedLen += commitText.length;
        try { onPostProcess(targetEl); } catch (e) { /* ignore */ }

        // Добавляем курсор в конец, если ещё что-то копим.
        if (cursorEl && pendingTail) {
            targetEl.appendChild(cursorEl);
        }

        if (pendingTail) _scheduleFlush();
        try { onScroll(); } catch (e) { /* ignore */ }
    }

    return {
        setEl(newEl) { targetEl = newEl; },
        setCursor(el) { cursorEl = el; },
        /**
         * Принять накопленный текст ответа (полный, как текущий text из onChunk).
         * Виртуальный displayText = stripMemoryBlock(text). Учёт смещений — на этой
         * длине (после stripMemoryBlock), чтобы memory-block не попадал в DOM.
         * @param {string} fullText — полный накопленный текст ответа (raw)
         */
        push(fullText) {
            if (destroyed || !targetEl) return;
            const displayText = preprocessed ? fullText : stripMemoryBlock(fullText);
            // Если displayText стал короче (memory-block был в середине и strip
            // вырезал его, или text был переписан серверной коррекцией):
            // безопасный путь — полный re-render displayText с нуля.
            if (displayText.length < renderedLen) {
                renderedLen = 0;
                pendingTail = displayText;
                lastFullDisplayText = displayText;
                _scheduleFlush();
                return;
            }
            // Нормальный случай: displayText растёт. pendingTail = дельта от
            // последнего зафиксированного в DOM.
            if (displayText !== lastFullDisplayText) {
                pendingTail = displayText.slice(renderedLen);
                lastFullDisplayText = displayText;
                _scheduleFlush();
            }
        },
        /** Принудительно слить хвост (abort / конец раунда / tool-call граница). */
        flush() {
            if (destroyed || !targetEl) return;
            // Игнорируем «безопасную границу» — рендерим всё, что накопилось.
            if (pendingTail) {
                if (renderedLen === 0) {
                    targetEl.innerHTML = renderMarkdown(pendingTail);
                } else {
                    targetEl.insertAdjacentHTML('beforeend', renderMarkdown(pendingTail));
                }
                renderedLen += pendingTail.length;
                pendingTail = '';
                try { onPostProcess(targetEl); } catch (e) { /* ignore */ }
                try { onScroll(); } catch (e) { /* ignore */ }
            }
        },
        /** Сброс для нового раунда tool-call. */
        reset() {
            renderedLen = 0;
            pendingTail = '';
            lastFullDisplayText = '';
            rafScheduled = false;
        },
        destroy() {
            destroyed = true;
            rafScheduled = false;
        }
    };
}