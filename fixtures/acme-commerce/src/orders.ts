export function checkout(cart, payment, email) {
  if (!payment.captured) throw new Error('payment required');
  if (cart.guest && !email) throw new Error('email required for guest checkout');
  return { total: orderTotal(cart), key: checkoutIdempotencyKey(cart) };
}

export function orderTotal(cart) {
  return Math.max(0, cart.items.reduce((s, i) => s + i.price, 0)); // never negative
}

export function checkoutIdempotencyKey(cart) {
  return `checkout:${cart.id}`;
}

export function dedupeWebhook(event, seen) {
  return seen.has(event.id); // suppress re-delivery within the dedupe window
}

export function shipmentStatus(prev, next) {
  const order = ['pending', 'shipped', 'delivered'];
  return order.indexOf(next) >= order.indexOf(prev); // status never moves backward
}
