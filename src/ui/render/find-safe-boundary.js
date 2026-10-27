// Чистая функция «безопасной точки разрыва» для инкрементального рендера стриминга.
// Не имеет зависимостей от приложения — тестируется в node без DOM.
// Используется stream-renderer.js (см. там полный потоковый рендерер).

// Лимит «копить хвост»: если pending длиннее этого — рендерим целиком, не дожидаясь
// красивой границы. Страхует от pathological случаев (длинный абзац без \n\n).
// НЕ применяется к открытым code-fence: разрыв посередине фенса навсегда ломает
// раскраску остатка сообщения (закрывающий ``` становится «открывающим»).
export const MAX_PENDING_HOLD = 800;

// Абсолютный предел ожидания закрытия code-fence: если модель пишет код-фенс
// длиннее этого (или забыла закрыть), хвост коммитится как есть — рендерер
// переводит DOM в режим «открытый фенс» и дописывает код в тот же <code>.
export const MAX_FENCE_HOLD = 12000;

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
    let fenceStart = -1;
    for (let i = 0; i < text.length - 2; i++) {
        if (text.charCodeAt(i) === 96 /* ` */
            && text.charCodeAt(i + 1) === 96
            && text.charCodeAt(i + 2) === 96) {
            if (!inFence) fenceStart = i;
            inFence = !inFence;
            i += 2;
        }
    }
    // Если fence ещё открыт — резать внутри него нельзя: закоммиченный «сырой»
    // кусок навсегда останется текстом, а закрывающий ``` станет открывающим
    // для всего остального (весь хвост сообщения превращается в код).
    // Вместо этого коммитим текст ДО фенса по последнему \n\n перед ним…
    if (inFence) {
        for (let i = fenceStart - 2; i >= 1; i--) {
            if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10) {
                return i + 2;
            }
        }
        // …или ждём закрытия. Лимит MAX_FENCE_HOLD — страховка от бесконечного
        // ожидания, если модель забыла закрыть фенс: коммитим как есть, рендерер
        // откроет <code> и продолжит дописывать в него (см. stream-renderer).
        if (text.length >= MAX_FENCE_HOLD) return text.length;
        return -1;
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
            let nextIsListItem = (ch === 42 /* * */ || ch === 45 /* - */ || ch === 43 /* + */)
                && j + 1 < text.length
                && (text.charCodeAt(j + 1) === 32 || text.charCodeAt(j + 1) === 9);
            // Нумерованный пункт «2. » — тоже продолжение списка: иначе \n\n перед ним
            // режет ol пополам и нумерация в стриме перезапускается с 1.
            if (!nextIsListItem && ch >= 48 && ch <= 57) {
                let k = j;
                while (k < text.length && text.charCodeAt(k) >= 48 && text.charCodeAt(k) <= 57) k++;
                nextIsListItem = k > j && text.charCodeAt(k) === 46 /* . */
                    && (text.charCodeAt(k + 1) === 32 || text.charCodeAt(k + 1) === 9);
            }
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