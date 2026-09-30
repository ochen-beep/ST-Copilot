// FNV-1a 32-bit хэш для использования в качестве компактного ключа кэша
// вместо хранения полных промпт-строк (десятки тысяч символов на ключ).
// https://tools.ietf.org/html/draft-eastlake-fnv-03

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Converts a 32-bit unsigned value to hex (base 16, lowercase, 8 chars).
function toHex(n) {
    // Bitwise ops are signed in JS; coerce to unsigned with >>>0, then to base 16.
    return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * Возвращает 32-битный FNV-1a хэш строки как 8-символьную hex-строку.
 * Детерминирован, быстр, не зависит от движка (pure JS).
 */
export function fnv1a32(str) {
    let hash = FNV_OFFSET;
    if (!str) return toHex(hash);
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        // Эквивалент hash *= FNV_PRIME в 32-bit арифметике.
        hash = Math.imul(hash, FNV_PRIME);
    }
    return toHex(hash);
}

/**
 * Возвращает составной ключ для кэша: `${fnv1a32(text)}:${text.length}`.
 * Длина добавлена как дешёвая страховка против коллизий — для одного tokenCount
 * она почти бесплатна, но даёт различие для строк, совпадающих с очень малой
 * вероятностью по хэшу.
 */
export function cacheKey(text) {
    const len = typeof text === 'string' ? text.length : 0;
    return `${fnv1a32(text)}:${len}`;
}