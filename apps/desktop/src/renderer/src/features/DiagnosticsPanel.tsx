// DiagnosticsPanel — the "settings" surface for support (decisions 13, 32): a JSONL run-log viewer
// (list + open one raw) and a one-click "Copy diagnostics" that puts version/OS/auth/recent-runs on
// the clipboard. No telemetry leaves the machine; this is the manual, local equivalent.
import { useEffect, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary } from '../shared/ui';
import type { RunLogEntry } from '../entities/node';

export function DiagnosticsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [logs, setLogs] = useState<RunLogEntry[]>([]);
  const [open, setOpen] = useState<{ file: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.alethic.listLogs().then(setLogs);
  }, []);

  const copyDiagnostics = (): void => {
    void window.alethic.collectDiagnostics().then((text) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    });
  };

  const openLog = (file: string): void => {
    void window.alethic.readLog(file).then((c) => c && setOpen({ file: c.file, text: c.text }));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(35,34,30,0.35)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: T.sans,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, calc(100vw - 48px))',
          height: 'min(560px, calc(100% - 64px))',
          background: T.paper,
          border: `1.5px solid ${T.line}`,
          borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: `1.5px solid ${T.lineSoft}`,
          }}
        >
          <span style={{ fontFamily: T.serif, fontSize: 15, fontWeight: 600, color: T.ink }}>
            Diagnostics
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={copyDiagnostics}
            style={{ ...btnPrimary, padding: '6px 12px', fontSize: 12 }}
          >
            {copied ? '✓ Copied' : 'Copy diagnostics'}
          </button>
          <button onClick={onClose} style={{ ...btnGhost, padding: '6px 10px', fontSize: 12 }}>
            ✕
          </button>
        </div>

        {open ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
                borderBottom: `1.5px solid ${T.lineSoft}`,
              }}
            >
              <button
                onClick={() => setOpen(null)}
                style={{ ...btnGhost, padding: '4px 9px', fontSize: 11 }}
              >
                ← back
              </button>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.sub }}>{open.file}</span>
            </div>
            <pre
              style={{
                flex: 1,
                overflow: 'auto',
                margin: 0,
                padding: '10px 14px',
                fontFamily: T.mono,
                fontSize: 10.5,
                lineHeight: 1.5,
                color: T.ink,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {open.text}
            </pre>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: T.faint,
                margin: '4px 0 8px',
              }}
            >
              Agent run logs · {logs.length}
            </div>
            {logs.length === 0 ? (
              <div style={{ color: T.sub, fontSize: 12.5, padding: '20px 4px', lineHeight: 1.6 }}>
                No agent runs recorded yet. Every scan, sync, plan and execution appends a JSONL log
                here — they show up once the agent has done something.
              </div>
            ) : (
              logs.map((l) => (
                <div
                  key={l.file}
                  onClick={() => openLog(l.file)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: `1.5px solid ${T.lineSoft}`,
                    background: T.card,
                    cursor: 'pointer',
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: '#fff',
                      background: T.blue,
                      borderRadius: 5,
                      padding: '1px 6px',
                    }}
                  >
                    {l.role}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink }}>{l.model}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint }}>
                    {new Date(l.startedAt).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
