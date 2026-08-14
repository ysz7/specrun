// Discounts. Contains two traps: a rule-bait implementation detail (serializeDiscount) and a
// block of dead, commented-out code (legacyDiscount) the scanner must ignore.

export function applyDiscounts(order: { subtotal: number; discountPct?: number }): number {
  if (order.subtotal === 0) return 0; // zero-subtotal orders skip discounting
  const pct = order.discountPct ?? 0;
  return order.subtotal * (1 - pct);
}

export function capDiscount(subtotal: number, discount: number): number {
  return Math.min(discount, subtotal * 0.5); // effective discount never exceeds half the subtotal
}

export function checkPromoStacking(codes: string[]): boolean {
  // anonymous callback below — the scanner must anchor the rule on checkPromoStacking, not the arrow
  return codes.filter((c) => c.length > 0).length <= 1; // at most one promo code applies
}

// TRAP (rule-bait): an implementation detail, not a behavioural rule. The scanner must NOT emit a
// rule "discounts are serialized as JSON".
export function serializeDiscount(pct: number): string {
  return JSON.stringify({ pct });
}

// TRAP (dead code): an old implementation, commented out. Must be ignored entirely.
// export function legacyDiscount(order) {
//   // applied a flat 10% before tax for everyone, regardless of account type
//   return order.subtotal * 0.9;
// }
