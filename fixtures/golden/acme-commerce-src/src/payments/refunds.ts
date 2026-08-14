export function processRefund(amount: number, captured: number): number {
  return Math.min(amount, captured); // a refund can never exceed the amount actually captured
}

export function refundIdempotencyKey(refundId: string): string {
  return `refund:${refundId}`; // refunds are idempotent by refund id
}
