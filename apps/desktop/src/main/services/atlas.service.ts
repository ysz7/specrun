// AtlasService — owns a project's .alethic/: loads it into a snapshot, watches for on-disk
// changes (including hand edits in another editor, decision 12) and emits incremental patches.
// Deliberately Electron-free so it can be unit-tested and, later, reused by a CLI.
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import {
  applyPatch,
  buildIndex,
  entryFlags,
  loadAlethicDir,
  parse,
  toEntryMap,
  toIndexEntries,
  type IndexEntry,
  type IndexJson,
  type NodeMeta,
} from '@alethic/format';
import type { AtlasEvent, AtlasSnapshot, SnapshotNode } from '@alethic/ipc';

type AtlasListener = (event: AtlasEvent) => void;

const toPosix = (p: string): string => p.split(sep).join('/');

function safeParse(text: string): { meta: NodeMeta | null; body: string; conflict: boolean } {
  try {
    const parsed = parse(text);
    return { meta: parsed.meta, body: parsed.body, conflict: parsed.conflict };
  } catch {
    // Invalid (non-conflict) frontmatter: keep the node visible but unindexed.
    return { meta: null, body: text, conflict: false };
  }
}

export class AtlasService {
  private root: string | null = null;
  private alethicDir: string | null = null;
  private entries = new Map<string, IndexEntry>();
  private nodesByPath = new Map<string, SnapshotNode>();
  private index: IndexJson | null = null;
  private mode: 'dev' | 'plan' = 'dev'; // read from config.yaml (decision 54)
  private watcher: FSWatcher | null = null;
  private readonly listeners = new Set<AtlasListener>();

  /** Open a project root (the folder that contains `.alethic/`) and start watching. */
  open(root: string): AtlasSnapshot {
    this.close();
    this.root = root;
    this.alethicDir = join(root, '.alethic');

    const { nodes, config } = loadAlethicDir(this.alethicDir);
    this.mode = config?.mode ?? 'dev';
    this.nodesByPath = new Map(
      nodes.map((n) => [
        n.path,
        { path: n.path, meta: n.meta, body: n.body, conflict: n.conflict },
      ]),
    );
    this.entries = toEntryMap(toIndexEntries(nodes));
    this.index = buildIndex([...this.entries.values()]);
    this.startWatching();
    return this.requireSnapshot();
  }

  /** The current snapshot, or null when no project is open. */
  snapshot(): AtlasSnapshot | null {
    if (!this.root || !this.index) return null;
    return {
      root: this.root,
      index: this.index,
      nodes: [...this.nodesByPath.values()],
      mode: this.mode,
    };
  }

  /** Update the in-memory mode (after the config's mode was rewritten on disk). */
  setMode(mode: 'dev' | 'plan'): void {
    this.mode = mode;
  }

  /** The open project root, or null. Used by the code-read handler to resolve anchor files. */
  projectRoot(): string | null {
    return this.root;
  }

  /** Subscribe to live patch events; returns an unsubscribe function. */
  onEvent(listener: AtlasListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop watching and drop all state. */
  close(): void {
    void this.watcher?.close();
    this.watcher = null;
    this.root = null;
    this.alethicDir = null;
    this.index = null;
    this.mode = 'dev';
    this.entries.clear();
    this.nodesByPath.clear();
  }

  private requireSnapshot(): AtlasSnapshot {
    const snap = this.snapshot();
    if (!snap) throw new Error('no project open');
    return snap;
  }

  private startWatching(): void {
    if (!this.alethicDir) return;
    // Dot-dirs are ignored at the watcher, not just in the handler below: `.backup/` holds a full
    // copy of the map per snapshot, so watching it means an event storm on every backup — and, on
    // Windows, open handles inside a directory the pruner is trying to delete (the ENOTEMPTY that
    // killed Deepen, Phase 2.1).
    this.watcher = watch(this.alethicDir, {
      ignoreInitial: true,
      ignored: (path) =>
        relative(this.alethicDir!, path)
          .split(/[\\/]/)
          .some((s) => s.startsWith('.')),
    });
    this.watcher.on('add', (p) => void this.onFsChange('add', p));
    this.watcher.on('change', (p) => void this.onFsChange('change', p));
    this.watcher.on('unlink', (p) => void this.onFsChange('unlink', p));
  }

  private async onFsChange(reason: AtlasEvent['reason'], absPath: string): Promise<void> {
    if (!this.alethicDir || !absPath.endsWith('.md')) return;
    const rel = toPosix(relative(this.alethicDir, absPath));
    // Mirror the loader: ignore dot-dirs like `.backup/` so snapshots never leak into the live map.
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return;

    let node: SnapshotNode | undefined;
    if (reason === 'unlink') {
      this.nodesByPath.delete(rel);
      applyPatch(this.entries, { path: rel });
    } else {
      const text = await readFile(absPath, 'utf8');
      const parsed = safeParse(text);
      node = { path: rel, meta: parsed.meta, body: parsed.body, conflict: parsed.conflict };
      this.nodesByPath.set(rel, node);
      if (parsed.meta)
        applyPatch(this.entries, {
          path: rel,
          // Same flags the full load computes (`toIndexEntries`) — a node rewritten while the app
          // is open must gain or lose its form marker live, not only after a reopen.
          entry: { path: rel, meta: parsed.meta, ...entryFlags(parsed.meta, parsed.body) },
        });
      else applyPatch(this.entries, { path: rel });
    }

    this.index = buildIndex([...this.entries.values()]);
    const event: AtlasEvent = { reason, path: rel, index: this.index, ...(node ? { node } : {}) };
    for (const listener of this.listeners) listener(event);
  }
}
