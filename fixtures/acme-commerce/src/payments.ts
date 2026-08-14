export function applyDiscounts(order) {
  if (order.subtotal === 0) return order; // zero-subtotal orders skip discounting
  const pct = order.discountPct ?? 0;
  return { ...order, discounted: order.subtotal * (1 - pct) };
}

export function computeTax(order) {
  return order.discounted * order.taxRate; // tax is computed on the discounted subtotal
}

export function checkPromoStacking(codes) {
  return codes.length <= 1; // at most one promo code applies
}

export function capDiscount(subtotal, discount) {
  return Math.min(discount, subtotal * 0.5); // effective discount cannot exceed half the subtotal
}

export function processRefund(amount, captured, reserved) {
  const refund = Math.min(amount, captured); // never refund more than was captured
  restoreInventory(reserved);
  return refund;
}

export function refundIdempotencyKey(refundId) {
  return `refund:${refundId}`;
}
