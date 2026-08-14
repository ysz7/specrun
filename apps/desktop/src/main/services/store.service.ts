// StoreService — persists recent projects and window bounds across sessions (decision 37),
// via electron-store. Alethic keeps this local; there is no Alethic account or server.
import { basename } from 'node:path';
import Store from 'electron-store';
import type { RecentProject } from '@alethic/ipc';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

interface Schema {
  recent: RecentProject[];
  window: WindowState;
  /** Which generation of window defaults the saved bounds came from (see WINDOW_DEFAULTS_GEN). */
  windowGen: number;
}

/**
 * Bumping WINDOW_DEFAULTS_GEN retires bounds saved under older defaults exactly once, so a change
 * to the opening size is actually seen instead of being shadowed forever by a stale saved one.
 * The size itself is not decided here — the store persists, the caller picks the default from the
 * display it is about to open on.
 */
const WINDOW_DEFAULTS_GEN = 5;

const DEFAULTS: Schema = {
  recent: [],
  window: { width: 1250, height: 725 }, // only a fallback; the caller picks the default
  windowGen: 0,
};

const MAX_RECENT = 10;

export class StoreService {
  private readonly store = new Store<Schema>({ name: 'alethic', defaults: DEFAULTS });

  recentProjects(): RecentProject[] {
    return this.store.get('recent');
  }

  rememberProject(path: string): RecentProject[] {
    const now = new Date().toISOString();
    const entry: RecentProject = { path, name: basename(path), lastOpened: now };
    const next = [entry, ...this.store.get('recent').filter((p) => p.path !== path)].slice(
      0,
      MAX_RECENT,
    );
    this.store.set('recent', next);
    return next;
  }

  /**
   * The user's remembered bounds, or null when there are none to honour — a first run, or bounds
   * saved under retired defaults. Null means "open at the default size, centered"; the caller sizes
   * it against the actual display.
   */
  windowState(): WindowState | null {
    if (this.store.get('windowGen') !== WINDOW_DEFAULTS_GEN) {
      this.store.set('windowGen', WINDOW_DEFAULTS_GEN);
      this.store.delete('window');
      return null;
    }
    return this.store.get('window');
  }

  saveWindowState(state: WindowState): void {
    this.store.set('window', state);
  }
}
