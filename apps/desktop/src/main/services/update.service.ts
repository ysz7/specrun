// UpdateService — the lightweight update check (decision 33): fetch a static JSON manifest, compare
// its version to the running app, and report whether a newer build exists. No auto-download, no
// telemetry — just a banner the renderer can show with a link to the release. electron-updater
// (auto-update) is deferred to a later version; a static JSON keeps the MVP dependency-free.
import type { UpdateInfo } from '@alethic/ipc';

// Overridable in dev/tests; points at a static file the release process publishes.
const DEFAULT_FEED = 'https://alethic.app/updates/latest.json';

interface Manifest {
  version: string;
  url?: string;
  notes?: string;
}

/** Compare two dotted numeric versions. Returns >0 if a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export class UpdateService {
  constructor(
    private readonly current: string,
    private readonly feedUrl: string = process.env['ALETHIC_UPDATE_FEED'] ?? DEFAULT_FEED,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Check the feed; never throws — a network failure just reports "up to date". */
  async check(): Promise<UpdateInfo> {
    const upToDate: UpdateInfo = { current: this.current, latest: this.current, available: false };
    try {
      const res = await this.fetchImpl(this.feedUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return upToDate;
      const manifest = (await res.json()) as Manifest;
      if (!manifest || typeof manifest.version !== 'string') return upToDate;
      const available = compareVersions(manifest.version, this.current) > 0;
      return {
        current: this.current,
        latest: available ? manifest.version : this.current, // never regress below what runs
        available,
        ...(available && manifest.url ? { url: manifest.url } : {}),
        ...(available && manifest.notes ? { notes: manifest.notes } : {}),
      };
    } catch {
      return upToDate;
    }
  }
}
