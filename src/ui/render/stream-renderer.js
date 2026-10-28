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
    // Экстренный коммит незакрытого code-fence (MAX_FENCE_HOLD): <code>-элемент,
    // в который дописываем последующий код как text node, пока не придёт
    // закрывающий ```. Без этого длинный стримящийся листинг показывался бы
    // сырым markdown, а закрывающий маркер «переворачивал» бы фенсы до конца
    // сообщения.
    let openFenceCodeEl = null;

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

    // Заканчивается ли текст незакрытым code-fence (нечётное число ```-маркеров).
    function _endsInsideFence(txt) {
        let count = 0;
        for (let i = 0; i < txt.length - 2; i++) {
            if (txt.charCodeAt(i) === 96 && txt.charCodeAt(i + 1) === 96 && txt.charCodeAt(i + 2) === 96) {
                count++;
                i += 2;
            }
        }
        return count % 2 === 1;
    }

    function _commitChunk(commitText) {
        if (!commitText) return;
        // Рендерим commit-чанк: для первого блока заменяем innerHTML, далее append.
        if (renderedLen === 0) {
            targetEl.innerHTML = renderMarkdown(commitText);
        } else {
            // append: insertAdjacentHTML держит существующие узлы, дописывает в конец.
            targetEl.insertAdjacentHTML('beforeend', renderMarkdown(commitText));
        }
        renderedLen += commitText.length;
        // Форсированный коммит незакрытого фенса (MAX_FENCE_HOLD): запоминаем его
        // <code>, чтобы дальше писать код туда, а не рендерить markdown заново.
        if (_endsInsideFence(commitText)) {
            const wraps = targetEl.querySelectorAll('.scp-code-block-wrap');
            openFenceCodeEl = wraps.length ? wraps[wraps.length - 1].querySelector('code') : null;
        }
    }

    // Потребление хвоста в режиме открытого фенса: код — text node'ами в открытый
    // <code>, закрывающий маркер-строку съедаем. Возвращает true, если режим
    // активен и хвост обработан (полностью или до закрытия фенса).
    function _consumeFenceTail() {
        if (!openFenceCodeEl) return false;
        const closeIdx = pendingTail.indexOf('```');
        if (closeIdx === -1) {
            openFenceCodeEl.appendChild(document.createTextNode(pendingTail));
            renderedLen += pendingTail.length;
            pendingTail = '';
            return true;
        }
        const codePart = pendingTail.slice(0, closeIdx);
        if (codePart) openFenceCodeEl.appendChild(document.createTextNode(codePart));
        let end = closeIdx + 3;
        while (end < pendingTail.length && pendingTail.charCodeAt(end) !== 10) end++;
        if (end < pendingTail.length) end++; // съесть \n после ```
        renderedLen += end;
        pendingTail = pendingTail.slice(end);
        openFenceCodeEl = null;
        return false; // фенс закрыт — дальше обычный markdown
    }

    function _flush() {
        if (destroyed || !targetEl) return;
        if (!pendingTail) return;

        // Курсор виден и пока хвост копится (граница ещё не найдена) —
        // иначе пустое сообщение в первые секунды стрима выглядит сломанным.
        if (cursorEl && !cursorEl.parentNode) targetEl.appendChild(cursorEl);

        let committed = false;
        while (pendingTail && !destroyed) {
            // Режим открытого фенса: хвост — это код; пишем его text node'ми
            // в тот же <code> до закрывающего ``` (маркер-строку потребляем).
            if (openFenceCodeEl) {
                if (_consumeFenceTail()) break; // хвост кончился внутри фенса
                continue; // фенс закрыт — остаток обрабатываем как обычно
            }

            const boundary = findSafeRenderBoundary(pendingTail);
            if (boundary < 0) break; // копим ещё

            const commitText = pendingTail.slice(0, boundary);
            pendingTail = pendingTail.slice(boundary);
            if (!commitText) break;
            _commitChunk(commitText);
            committed = true;
        }

        if (committed) {
            try { onPostProcess(targetEl); } catch (e) { /* ignore */ }
        }

        // Курсор всегда в конце targetEl: коммит, съевший весь хвост, иначе
        // оставлял бы курсор ПЕРЕД свежезакоммиченным блоком до следующего
        // чанка; при пустом хвосте курсор гаснет до следующего push.
        if (cursorEl) {
            cursorEl.remove();
            if (pendingTail) targetEl.appendChild(cursorEl);
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
                openFenceCodeEl = null;
                _scheduleFlush();
                return;
            }
            // Нормальный случай: displayText растёт. pendingTail = дельта от
            // последнего зафиксированного в DOM.
            if (displayText !== lastFullDisplayText) {
                // Only the tail may silently differ: a rewrite/normalization that
                // changed the already-committed prefix while keeping (or growing)
                // the length slips past the shrink check above — force a full
                // re-render for that case too.
                if (displayText.slice(0, renderedLen) !== lastFullDisplayText.slice(0, renderedLen)) {
                    renderedLen = 0;
                    openFenceCodeEl = null;
                }
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
                // В режиме открытого фенса закрывающий ``` может быть уже в хвосте —
                // его обязательно потребляем как маркер, иначе он уедет в код
                // (гонка принудительного flush с отложенным RAF-флашем).
                if (openFenceCodeEl) _consumeFenceTail();
                if (pendingTail) {
                    _commitChunk(pendingTail);
                    pendingTail = '';
                }
                try { onPostProcess(targetEl); } catch (e) { /* ignore */ }
                try { onScroll(); } catch (e) { /* ignore */ }
            }
            openFenceCodeEl = null;
        },
        /** Сброс для нового раунда tool-call. */
        reset() {
            renderedLen = 0;
            pendingTail = '';
            lastFullDisplayText = '';
            rafScheduled = false;
            openFenceCodeEl = null;
        },
        destroy() {
            destroyed = true;
            rafScheduled = false;
        }
    };
}