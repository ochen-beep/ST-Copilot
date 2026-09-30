// Чистая функция «безопасной точки разрыва» для инкрементального рендера стриминга.
// Не имеет зависимостей от приложения — тестируется в node без DOM.
// Используется stream-renderer.js (см. там полный потоковый рендерер).

// Лимит «копить хвост»: если pending длиннее этого — рендерим целиком, не дожидаясь
// красивой границы. Страхует от pathological случаев (длинный абзац без \n\n,
// древовидный code-fence).
export const MAX_PENDING_HOLD = 800;

/**
 * Находит индекс безопасной точки разрыва в `text` (для инкрементального рендера).
 * Возвращает длину префикса, который можно безопасно отрендерить и зафиксировать,
 * оставив хвост(text.slice(idx)) дожидаться следующего flush. Возвращает -1, если
 * безопасной точки нет и накоплено меньше MAX_PENDING_HOLD — копим дальше.
 *
 * Безопасные границы (в порядке убывания предпочтения):
 *   1. последний `\n\n` (paragraph boundary), НЕ внутри code-fence и НЕ внутри
 *      продолжающегося списка (`^\s*[*-]\s+` после).
 *   2. конец code-fence (``` с переводом строки после).
 *   3. конец (если text уже завершён).
 *
 * Чистая функция — unit-тестируется без DOM.
 *
 * @param {string} text — накопленный полный текст ответа (уже после stripMemoryBlock)
 * @returns {number} индекс точки разрыва, или -1 («копим ещё»)
 */
export function findSafeRenderBoundary(text) {
    if (typeof text !== 'string' || text.length === 0) return -1;

    // 1. Определяем, открыта ли code-fence: считаем количество ``` на строках-началах.
    //    Упрощённо: проходим по ```, toggle'им inFence.
    let inFence = false;
    for (let i = 0; i < text.length - 2; i++) {
        if (text.charCodeAt(i) === 96 /* ` */
            && text.charCodeAt(i + 1) === 96
            && text.charCodeAt(i + 2) === 96) {
            inFence = !inFence;
            i += 2;
        }
    }
    // Если fence ещё открыт — безопасно резать только на закрывающем ```.
    // Пока он не пришёл — режем не внутри: ждём (return -1), если хвост короткий.
    if (inFence) {
        // есть ли ``` вообще в конце text? inFence=true значит, что последний ```
        // был открывающим. Мы не режем, пока не закроется.
        if (text.length < MAX_PENDING_HOLD) return -1;
        // Если накопилось уже много — fallback к концу (полный рендер хвоста).
        return text.length;
    }

    // 2. Ищем последний `\n\n`.
    let lastBoundary = -1;
    for (let i = 1; i < text.length - 1; i++) {
        if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10) {
            // \n\n встречается: проверяем, не является ли граница продолжением
            // списка (т.е. что следующая строка НЕ начинается с `* ` или `- `).
            const afterIdx = i + 2;
            // skip optional whitespace
            let j = afterIdx;
            while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
            const ch = text.charCodeAt(j);
            const nextIsListItem = (ch === 42 /* * */ || ch === 45 /* - */)
                && j + 1 < text.length
                && (text.charCodeAt(j + 1) === 32 || text.charCodeAt(j + 1) === 9);
            if (!nextIsListItem) {
                lastBoundary = i + 2; // режем после \n\n
            }
        }
    }
    if (lastBoundary > 0) return lastBoundary;

    // 3. Нет границы и хвост короткий — копим дальше.
    if (text.length < MAX_PENDING_HOLD) return -1;

    // 4. Fallback: рендерим целиком (pathological кейс).
    return text.length;
}