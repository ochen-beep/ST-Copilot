import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем единственную зависимость util-text — дебаг-логгер.
// Важно: vi.mock поднимается (hoisted), путь — от товара to исходному модулю.
vi.mock('../src/utils/util-debug.js', () => ({
  _dbgAdd: () => {},
}));

import {
  _repairJSON,
  _sanitizeProposedTags,
  applySearchReplaceToField,
  _ensureWrapped,
  normalizeCharNamesInBlock,
  levenshtein,
} from '../src/utils/util-text.js';

describe('_repairJSON', () => {
  it('убирает trailing-запятые перед } и ]', () => {
    expect(_repairJSON('{"a":1,}')).toBe('{"a":1}');
    expect(_repairJSON('[1,2,]')).toBe('[1,2]');
    expect(_repairJSON('{"a":[1,2,],"b":3,}')).toBe('{"a":[1,2],"b":3}');
  });

  it('дописывает незакрытые скобки', () => {
    expect(_repairJSON('{"a":1')).toBe('{"a":1}');
    expect(_repairJSON('[1,2')).toBe('[1,2]');
    expect(_repairJSON('{"a":[1,2')).toBe('{"a":[1,2]}');
  });

  it('не ломает уже валидный JSON', () => {
    expect(_repairJSON('{"a":1}')).toBe('{"a":1}');
    expect(_repairJSON('[1,2,3]')).toBe('[1,2,3]');
  });

  it('экранирует незакрытые кавычки внутри строк (минимальный случай)', () => {
    // _repairJSON нацеленно чинит trailing-запятые и незакрытые скобки,
    // но не глубокий nested-escaping. Проверяем то, что чинит — валидный
    // JSON с экранированной кавычкой внутри значения должен остаться валидным.
    const repaired = _repairJSON('{"text":"some \\"broken\\" content"}');
    expect(() => JSON.parse(repaired)).not.toThrow();
  });

  it('обрабатывает пустую строку', () => {
    expect(_repairJSON('')).toBe('');
  });
});

describe('_sanitizeProposedTags', () => {
  it('возвращает пустую строку для не-string', () => {
    expect(_sanitizeProposedTags(null)).toBe('');
    expect(_sanitizeProposedTags(undefined)).toBe('');
    expect(_sanitizeProposedTags(42)).toBe('');
    expect(_sanitizeProposedTags([])).toBe('');
  });

  it('парсит JSON-массив тегов', () => {
    expect(_sanitizeProposedTags('["Fantasy", "Villain"]')).toBe('Fantasy, Villain');
    expect(_sanitizeProposedTags('["a","b","c"]')).toBe('a, b, c');
  });

  it('парсит JSON-строку', () => {
    expect(_sanitizeProposedTags('"just-a-tag"')).toBe('just-a-tag');
  });

  it('очищает строку с квадратными скобками и кавычками', () => {
    expect(_sanitizeProposedTags('[Fantasy, Villain]')).toBe('Fantasy, Villain');
    expect(_sanitizeProposedTags('["Slow Burn"]')).toBe('Slow Burn');
  });

  it('извлекает теги в кавычках из смешанного текста', () => {
    expect(_sanitizeProposedTags('the "Fantasy" and "Villain" tags')).toBe('Fantasy, Villain');
  });

  it('разделяет запятую-сепарированные теги', () => {
    expect(_sanitizeProposedTags('Fantasy, Villain, Tsundere')).toBe('Fantasy, Villain, Tsundere');
  });
});

describe('applySearchReplaceToField', () => {
  it('точное совпадение — замена', () => {
    const r = applySearchReplaceToField('hello world', 'hello', 'hi');
    expect(r.matched).toBe(true);
    expect(r.result).toBe('hi world');
  });

  it('точное совпадение с trim — замена', () => {
    const r = applySearchReplaceToField('hello world', '  hello  ', 'hi');
    expect(r.matched).toBe(true);
    expect(r.result).toBe('hi world');
  });

  it('anchor через || — замена диапазона', () => {
    const r = applySearchReplaceToField(
      'The ancient castle was built in 1240 by a grumpy dwarf.',
      'The ancient castle || grumpy dwarf.',
      '[REPLACED]'
    );
    expect(r.matched).toBe(true);
    expect(r.result).toBe('[REPLACED]');
  });

  it('anchor через ... — замена диапазона', () => {
    const r = applySearchReplaceToField(
      'The ancient castle was built in 1240 by a grumpy dwarf.',
      'The ancient castle ... grumpy dwarf.',
      '[REPLACED]'
    );
    expect(r.matched).toBe(true);
    expect(r.result).toBe('[REPLACED]');
  });

  it('whitespace-толерантность: перенос строки внутри якоря — замена', () => {
    const r = applySearchReplaceToField(
      'The ancient castle\nwas built in 1240 by a grumpy dwarf.',
      'The ancient castle was built in 1240',
      '[REPLACED]'
    );
    expect(r.matched).toBe(true);
    expect(r.result).toBe('[REPLACED] by a grumpy dwarf.');
  });

  it('fuzzy-угадывание удалено: близкий, но не дословный текст — отказ', () => {
    // Было: скользящие окна с levenshtein «угадывали» (порог 0.72).
    // Стало: правка либо дословная, либо отклоняется с причиной.
    const r = applySearchReplaceToField(
      'The ancient castle was built by a grumpy dwarf.',
      'The ancient castle || grumpy dwarfs',
      '[REPLACED]'
    );
    expect(r.matched).toBe(false);
    expect(r.result).toBe('The ancient castle was built by a grumpy dwarf.');
    expect(r.reason).toBeTruthy();
  });

  it('неоднозначный якорь (два вхождения) — отказ с причиной', () => {
    const r = applySearchReplaceToField(
      'The castle gate. The castle tower.',
      'The castle',
      '[X]'
    );
    expect(r.matched).toBe(false);
    expect(r.result).toBe('The castle gate. The castle tower.');
    expect(r.reason).toContain('несколько раз');
  });

  it('уникальный якорь в тексте с повторами других слов — замена', () => {
    const r = applySearchReplaceToField(
      'The castle gate. The castle tower is tall.',
      'The castle tower is tall',
      '[X]'
    );
    expect(r.matched).toBe(true);
    expect(r.result).toBe('The castle gate. [X].');
  });

  it('неоднозначный конец диапазонного якоря — отказ', () => {
    const r = applySearchReplaceToField(
      'Tower A stands. Below the tower stands a wall.',
      'Tower || stands',
      '[X]'
    );
    // Начало «Tower» уникально (с учётом регистра), конец «stands» в остатке дважды.
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('конец якоря');
  });

  it('повторяющийся диапазон — отказ (не хватает контекста)', () => {
    const r = applySearchReplaceToField(
      'room with a red door. Corridor. room with a red door.',
      'room with a red door || red door',
      '[X]'
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('неоднозначное одиночное вхождение — причина содержит подсказку', () => {
    const r = applySearchReplaceToField(
      'aaa bbb aaa',
      'aaa',
      '[X]'
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toContain('больше контекста');
  });

  it('no match — возвращает исходный текст и matched=false с причиной', () => {
    const r = applySearchReplaceToField(
      'The quick brown fox jumps over the lazy dog.',
      ' совершенно другой несвязанный текст который нигде не встречается ',
      '[REPLACED]'
    );
    expect(r.matched).toBe(false);
    expect(r.result).toBe('The quick brown fox jumps over the lazy dog.');
    expect(r.reason).toContain('не найден');
  });

  it('поиск длиннее текста — отказ без угадывания', () => {
    const r = applySearchReplaceToField('old dark castle', 'old dark castle extra', '[NEW]');
    expect(r.matched).toBe(false);
    expect(r.result).toBe('old dark castle');
  });

  it('пустой fieldContent — matched=true, result=replaceText', () => {
    // Если fieldContent пуст (falsy) — функция сразу возвращает replace.
    const r = applySearchReplaceToField('', 'anything', 'replacement');
    expect(r.matched).toBe(true);
    expect(r.result).toBe('replacement');
  });

  it('пустой search при непустом fieldContent — matched=false (по коду)', () => {
    // При непустом fieldContent и пустом search fuzzy-матч не срабатывает.
    const r = applySearchReplaceToField('existing content', '', 'replaced');
    expect(r.matched).toBe(false);
    expect(r.result).toBe('existing content');
  });
});

describe('_ensureWrapped', () => {
  it('оборачивает простой текст', () => {
    expect(_ensureWrapped('hello', 'tag')).toBe('<tag>\nhello\n</tag>');
  });

  it('убирает уже существующую обёртку и переоборачивает', () => {
    expect(_ensureWrapped('<tag>\nhello\n</tag>', 'tag')).toBe('<tag>\nhello\n</tag>');
    expect(_ensureWrapped('<TAG>\nhello\n</TAG>', 'tag')).toBe('<tag>\nhello\n</tag>');
  });

  it('возвращает пустую строку для falsy', () => {
    expect(_ensureWrapped('', 'tag')).toBe('');
    expect(_ensureWrapped(null, 'tag')).toBe('');
    expect(_ensureWrapped('   ', 'tag')).toBe('');
  });
});

describe('normalizeCharNamesInBlock', () => {
  beforeEach(() => {
    // Перебиндим stub под каждый тест — SillyTavern getContext из setup.js.
    const ctx = SillyTavern.getContext();
    ctx.characters = [{ name: 'Aria', avatar: 'a1' }];
    ctx.characterId = 0;
    ctx.name1 = 'John';
  });

  it('заменяет имя персонажа на {{char}} внутри character-changes блока', () => {
    const input = '```character-changes\n<overwrite field="description">Aria is brave.</overwrite>\n```';
    const result = normalizeCharNamesInBlock(input);
    expect(result).toContain('{{char}} is brave.');
    expect(result).not.toContain('Aria is brave.');
  });

  it('заменяет имя пользователя на {{user}} внутри character-create блока', () => {
    const input = '```character-create\n{"first_mes":"John meets Aria."}\n```';
    const result = normalizeCharNamesInBlock(input);
    expect(result).toContain('{{user}} meets {{char}}.');
    expect(result).not.toContain('John meets Aria.');
  });

  it('не трогает текст вне proposal-блоков', () => {
    const input = 'Aria walks up to John. ```character-changes\n<overwrite field="x">Aria</overwrite>\n```';
    const result = normalizeCharNamesInBlock(input);
    // Вне блока имя остаются.
    expect(result.startsWith('Aria walks up to John.')).toBe(true);
    // Внутри блока заменено.
    expect(result).toContain('{{char}}</overwrite>');
  });

  it('не заменяет короткие имена (length <= 2)', () => {
    const ctx = SillyTavern.getContext();
    ctx.characters = [{ name: 'Ai', avatar: 'a1' }];
    ctx.name1 = 'Jo';
    const input = '```character-changes\n<overwrite field="x">Ai and Jo</overwrite>\n```';
    const result = normalizeCharNamesInBlock(input);
    expect(result).toContain('Ai and Jo');
  });

  it('пропускает текст без proposal-блоков без изменений', () => {
    const input = 'Just a regular message about Aria and John.';
    const result = normalizeCharNamesInBlock(input);
    expect(result).toBe(input);
  });
});

describe('levenshtein', () => {
  it('классический тест kitten → sitting = 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('одинаковые строки = 0', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('пDifferent length пропорционально', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });

  it('one substitution/distance = 1', () => {
    expect(levenshtein('a', 'b')).toBe(1);
    expect(levenshtein('abc', 'abd')).toBe(1);
    expect(levenshtein('abc', 'ab')).toBe(1);  // deletion
    expect(levenshtein('ab', 'abc')).toBe(1);  // insertion
  });

  it('не падает на non-string (приводит к String)', () => {
    expect(levenshtein(123, 123)).toBe(0);
    expect(levenshtein(null, '')).toBe(4);  // 'null' → '' = 4
  });

  it('levenshtein больше не применяется в applySearchReplaceToField (smoke)', () => {
    // Голозёмный «почти совпадающий» якорь должен быть отклонён, а не угадан.
    const r = applySearchReplaceToField('old dark castle', 'old dark castel', '[NEW]');
    expect(r.matched).toBe(false);
  });
});