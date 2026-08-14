// StatusBar — the thin bottom bar: git branch (toggles the Git panel), a live process indicator
// with a Stop popover (decision 46), and a terminal toggle (decision 45). Polls the process list
// so a `npm run dev` shows up and can be stopped from here or the popover.
import { useEffect, useState } from 'react';
import { T } from '../shared/tokens';
import type { ProcessInfo } from '../entities/node';

interface StatusBarProps {
  gitOpen: boolean;
  terminalOpen: boolean;
  onToggleGit: () => void;
  onToggleTerminal: () => void;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
}

export function StatusBar({
  gitOpen,
  terminalOpen,
  onToggleGit,
  onToggleTerminal,
  onOpenDiagnostics,
  onOpenSettings,
}: StatusBarProps): React.JSX.Element {
  const [branch, setBranch] = useState<string | null>(null);
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [popover, setPopover] = useState(false);

  useEffect(() => {
    const tick = (): void => {
      void window.alethic.gitStatus().then((s) => setBranch(s?.branch ?? null));
      void window.alethic.processList().then(setProcs);
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  const stop = (id: string): void => {
    void window.alethic.processStop(id).then(() => window.alethic.processList().then(setProcs));
  };

  const item: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '0 10px',
    height: '100%',
    cursor: 'pointer',
    fontFamily: T.mono,
    fontSize: 10.5,
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 26,
        zIndex: 45,
        background: T.card,
        borderTop: `1.5px solid ${T.lineSoft}`,
        display: 'flex',
        alignItems: 'center',
        color: T.sub,
      }}
    >
      <div
        onClick={onToggleGit}
        style={{ ...item, color: gitOpen ? T.orange : T.sub }}
        title="Source control"
      >
        ⑃ {branch ?? 'no repo'}
      </div>

      <div style={{ position: 'relative' }}>
        <div
          onClick={() => setPopover((p) => !p)}
          style={{ ...item, color: procs.length ? T.orange : T.sub }}
          title="Running processes"
        >
          ⚙ {procs.length} running
        </div>
        {popover && procs.length > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: 28,
              left: 4,
              minWidth: 240,
              background: T.card,
              border: `1.5px solid ${T.line}`,
              borderRadius: 8,
              boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
              padding: 6,
            }}
          >
            {procs.map((p) => (
              <div
                key={p.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px' }}
              >
                <span style={{ flex: 1, fontFamily: T.mono, fontSize: 11, color: T.ink }}>
                  {p.title} · pid {p.pid}
                </span>
                <button
                  onClick={() => stop(p.id)}
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    color: '#fff',
                    background: T.orange,
                    border: 'none',
                    borderRadius: 5,
                    padding: '2px 8px',
                    cursor: 'pointer',
                  }}
                >
                  Stop
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <span style={{ flex: 1 }} />

      <div onClick={onOpenSettings} style={item} title="Settings — Claude account, updates">
        ⚙ settings
      </div>

      <div onClick={onOpenDiagnostics} style={item} title="Diagnostics & run logs">
        ⚑ diagnostics
      </div>

      <div
        onClick={onToggleTerminal}
        style={{ ...item, color: terminalOpen ? T.orange : T.sub }}
        title="Toggle terminal"
      >
        ⌗ terminal
      </div>
    </div>
  );
}
