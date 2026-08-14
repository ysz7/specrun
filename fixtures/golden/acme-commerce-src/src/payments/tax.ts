export function computeTax(discounted: number, rate: number): number {
  return discounted * rate; // tax is computed on the discounted subtotal, not the gross
}
