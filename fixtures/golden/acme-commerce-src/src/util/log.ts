// Infrastructural — carries no behavioural rule. The scanner should list it as such in its summary,
// not manufacture a rule from it.
export function log(...args: unknown[]): void {
  console.log('[acme]', ...args);
}
