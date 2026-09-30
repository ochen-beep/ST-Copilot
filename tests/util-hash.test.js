import { describe, it, expect } from 'vitest';
import { fnv1a32, cacheKey } from '../src/utils/util-hash.js';

describe('fnv1a32', () => {
  it('детерминирован — одинаковый результат на повторных вызовах', () => {
    expect(fnv1a32('hello world')).toBe(fnv1a32('hello world'));
    expect(fnv1a32('hello world')).toBe(fnv1a32('hello world'));
  });

  it('различает близкие строки', () => {
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'));
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abca'));
    expect(fnv1a32('test')).not.toBe(fnv1a32('tset'));
  });

  it('известные тест-векторы FNV-1a-32 (sanity от reference vector)', () => {
    // Reference test vectors для FNV-1a-32 из draft-eastlake-fnv-03.
    // Эти значения задокументированы как канонические для FNV-1a 32-bit.
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('возвращает 8-символьную hex-строку', () => {
    const h = fnv1a32('anything');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('обрабатывает пустую и falsy строку', () => {
    // Пустая строка → offset basis (cache-friendly sentinel).
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32(null)).toBe('811c9dc5');
    expect(fnv1a32(undefined)).toBe('811c9dc5');
  });

  it('Unicode стабилен (код-юниты)', () => {
    const h1 = fnv1a32('Привет');
    const h2 = fnv1a32('Привет');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(fnv1a32('Прuвет')); // латиница u вместо кириллицы и
  });
});

describe('cacheKey', () => {
  it('включает длину как страховку от коллизий', () => {
    expect(cacheKey('hello')).toBe(`${fnv1a32('hello')}:5`);
    expect(cacheKey('')).toBe(`${fnv1a32('')}:0`);
    expect(cacheKey(null)).toBe(`${fnv1a32(null)}:0`);
  });

  it('различает строки с одинаковым хэшем, но разной длиной', () => {
    const a = cacheKey('hello');      // len 5
    const b = cacheKey('hello      ');// len 11 (хэш может совпасть, длина точно разная)
    expect(a).not.toBe(b);
  });

  it('стабилен для одинаковых строк', () => {
    expect(cacheKey('same')).toBe(cacheKey('same'));
  });
});