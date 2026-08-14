// Checkout. Contains a rule-bait trap: the cart happens to be stored in a Map (cartStore) — a data
// structure choice, not a behavioural rule. The scanner must NOT emit "the cart is stored in a Map".

const cartStore = new Map<string, { items: { price: number }[]; guest: boolean }>();

export function orderTotal(cartId: string): number {
  const cart = cartStore.get(cartId);
  const items = cart?.items ?? [];
  return Math.max(0, items.reduce((sum, i) => sum + i.price, 0)); // order total is never negative
}

export function checkout(cartId: string, payment: { captured: boolean }, email?: string): string {
  const cart = cartStore.get(cartId);
  if (!payment.captured) throw new Error('payment required'); // checkout requires captured payment
  if (cart?.guest && !email) throw new Error('email required'); // guest checkout requires an email
  return checkoutIdempotencyKey(cartId);
}

export function checkoutIdempotencyKey(cartId: string): string {
  return `checkout:${cartId}`; // checkout is idempotent by key
}
