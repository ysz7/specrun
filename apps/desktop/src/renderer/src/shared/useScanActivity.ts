// useScanActivity — "a scan is reading the code right now", for every surface that must say so.
// A scan pass (deepen / rescan / update code map) runs for minutes in main with no window of its
// own: the button that started it has to stop offering itself, and the chat has to show that the
// map is busy, so a new task is not stacked on top of a running one (Phase 2.1, from dog-fooding).
// Asks main on mount — a panel opened mid-scan must not look idle — then follows progress events.
import { useEffect, useState } from 'react';
import type { ScanActivity } from '../entities/node';

export function useScanActivity(): ScanActivity {
  const [activity, setActivity] = useState<ScanActivity>({ running: false });

  useEffect(() => {
    let mounted = true;
    void window.alethic.scanActive().then((a) => mounted && setActivity(a));
    const off = window.alethic.onScanProgress((p) => {
      const running = p.phase === 'repo-map' || p.phase === 'decompose' || p.phase === 'scanning';
      setActivity({ running, ...(running && p.domain ? { domain: p.domain } : {}) });
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  return activity;
}
