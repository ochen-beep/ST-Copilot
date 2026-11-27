// Однопроходное обнаружение proposal-блоков в тексте ответа AI.
//
// Контекст: раньше _renderMsgBodyContent и restoreMessageDOM вызывали 4 независимых
// парсера (parseLBChangesFromText, parseCharChangesFromText, parseCharCreationFromText,
// parseChatChangesFromText) — каждый делает 2-4 regex-операции над всем текстом
// (поиск strict закрытого блока, поиск open незакрытого, strip). На длинных ответах
// AI это ~8-16 regex-сканов по всему тексту, в том числе когда ни одного блока нет.
//
// Здесь — один regex-проход извлекает все ```LANGID маркеры зако в тексте и
// возвращает {lb,char,charCreate,chat}. Calling code вызывает только relevant парсер.
//
// Важно: эта функция НЕ заменяет парсеры — она лишь решает, какие парсеры запускать.
// Парсеры остаются как есть (они, кроме флага наличия, возвращают распарсенный контент).
//
// Edge cases учтены согласованно с парсерами:
//   - "Stale ```LANGID" внутри чужого Markdown code-fence: парсеры бы тоже ложно
//     сработали (они тоже regex-ищут ```LANGID по всему тексту), так чтоповедение
//     discovery == поведение парсеров.
//   - Открытый блок (нет закрывающего ```): парсеры на это не падают, поэтому
//     discovery лишь сообщает "есть маркер" — ровно та же семантика.

const LANGIDS = {
    'lorebook-changes': 'lb',
    'character-changes': 'char',
    'character-create': 'charCreate',
    'chat-changes': 'chat',
    'preset-changes': 'preset',
};

// Один regex на все ```LANGID маркеры. Захватывает LANGID (буквы/цифры/дефисы).
// global — чтобы одним exec'ом обойти все вхождения.
const FENCE_RE = /```([a-zA-Z][\w-]*)/g;

/**
 * @param {string} text — любой текст (может быть null/undefined → все флаги false)
 * @returns {{lb: boolean, char: boolean, charCreate: boolean, chat: boolean, preset: boolean}}
 *          Флаги выставляются в true, если хотя бы один маркер ```LANGID найден.
 *          Порядок ключей зафиксирован для стабильности сериализации в тестах.
 */
export function discoverProposalBlocks(text) {
    const result = { lb: false, char: false, charCreate: false, chat: false, preset: false };
    if (!text || typeof text !== 'string') return result;

    FENCE_RE.lastIndex = 0;
    let m;
    while ((m = FENCE_RE.exec(text)) !== null) {
        const flag = LANGIDS[m[1]];
        if (flag) result[flag] = true;
        // Защита от zero-width match'а (теоретически невозможна с этим regex,
        // но дешёвая страховка от зацикливания).
        if (m.index === FENCE_RE.lastIndex) FENCE_RE.lastIndex++;
    }
    return result;
}