import { describe, expect, it } from 'vitest';
import { genId, slugify } from './ids.js';

describe('genId', () => {
  it('produces the right prefix and shape per kind', () => {
    expect(genId('rule')).toMatch(/^r-[0-9a-f]{6}$/);
    expect(genId('domain')).toMatch(/^d-[0-9a-f]{6}$/);
    expect(genId('sub')).toMatch(/^s-[0-9a-f]{6}$/);
    expect(genId('plan')).toMatch(/^p-[0-9a-f]{6}$/);
    expect(genId('plan-step')).toMatch(/^ps-[0-9a-f]{6}$/);
    expect(genId('root')).toMatch(/^a-[0-9a-f]{6}$/);
  });
  it('is (practically) unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => genId('rule')));
    expect(ids.size).toBe(500);
  });
});

describe('slugify', () => {
  it('kebab-cases and lowercases', () => {
    expect(slugify('Discount applies before tax')).toBe('discount-applies-before-tax');
    expect(slugify('  Promo   codes!! do not stack  ')).toBe('promo-codes-do-not-stack');
  });
  it('transliterates Cyrillic to ASCII', () => {
    expect(slugify('Скидка до налога')).toBe('skidka-do-naloga');
  });
  it('strips diacritics', () => {
    expect(slugify('Café Crème')).toBe('cafe-creme');
  });
  it('caps at 48 characters with no trailing dash', () => {
    const s = slugify('a'.repeat(60));
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith('-')).toBe(false);
  });
});
