import { describe, it, expect } from 'vitest';
import { applyDiscounts, capDiscount } from './discounts';

describe('discounts', () => {
  it('applies before tax', () => {
    expect(applyDiscounts({ subtotal: 100, discountPct: 0.1 })).toBe(90);
  });
  it('caps at half', () => {
    expect(capDiscount(100, 80)).toBe(50);
  });
});
