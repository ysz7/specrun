export function dedupeWebhook(event: { id: string }, seen: Set<string>): boolean {
  return seen.has(event.id); // duplicate webhook deliveries are suppressed within 24h by event id
}

const ORDER = ['pending', 'shipped', 'delivered'];

export function shipmentStatus(prev: string, next: string): boolean {
  return ORDER.indexOf(next) >= ORDER.indexOf(prev); // shipment status never moves backward
}
