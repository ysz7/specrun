// The renderer's single data source: the atlas snapshot from main plus its live patch stream.
// No local fake state — the pyramid always reflects what is on disk (plan Phase 3 task 3).
import { useCallback, useEffect, useState } from 'react';
import type { AtlasEvent, AtlasSnapshot, SnapshotNode } from '../entities/node';

export interface AtlasState {
  snapshot: AtlasSnapshot | null;
  loading: boolean;
  lastEvent: AtlasEvent | null;
  open: (dir: string) => Promise<void>;
  pick: () => Promise<void>;
  setMode: (mode: 'dev' | 'plan') => Promise<void>;
  close: () => void;
}

function patchNodes(nodes: SnapshotNode[], event: AtlasEvent): SnapshotNode[] {
  if (event.reason === 'unlink') return nodes.filter((n) => n.path !== event.path);
  if (!event.node) return nodes;
  const index = nodes.findIndex((n) => n.path === event.path);
  if (index < 0) return [...nodes, event.node];
  const next = nodes.slice();
  next[index] = event.node;
  return next;
}

export function useAtlas(): AtlasState {
  const [snapshot, setSnapshot] = useState<AtlasSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastEvent, setLastEvent] = useState<AtlasEvent | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.alethic.loadAtlas().then((s) => {
      if (!mounted) return;
      setSnapshot(s);
      setLoading(false);
    });
    const unsubscribe = window.alethic.onAtlasEvent((event) => {
      setLastEvent(event);
      setSnapshot((prev) =>
        prev ? { ...prev, index: event.index, nodes: patchNodes(prev.nodes, event) } : prev,
      );
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const open = useCallback(async (dir: string) => {
    setLoading(true);
    const s = await window.alethic.openProject(dir);
    setSnapshot(s);
    setLoading(false);
  }, []);

  const pick = useCallback(async () => {
    const dir = await window.alethic.pickProject();
    if (dir) await open(dir);
  }, [open]);

  const setMode = useCallback(async (mode: 'dev' | 'plan') => {
    const s = await window.alethic.setMode(mode);
    if (s) setSnapshot(s);
  }, []);

  // Return to Welcome without quitting — the project stays open in main until another is picked.
  const close = useCallback(() => setSnapshot(null), []);

  return { snapshot, loading, lastEvent, open, pick, setMode, close };
}
