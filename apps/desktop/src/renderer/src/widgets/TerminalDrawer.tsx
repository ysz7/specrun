// TerminalDrawer — the bottom terminal panel (decision 45). xterm.js tabs backed in main by
// node-pty (or the child_process fallback). The read-only "Executor" tab mirrors the agent's bash
// commands. Input flows to main; output streams back and is written to the matching tab's terminal.
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { T } from '../shared/tokens';
import { btnGhost } from '../shared/ui';
import type { TerminalSessionInfo } from '../entities/node';

const XTERM_THEME = {
  background: '#1d1c19',
  foreground: '#e9e4d8',
  cursor: '#d9622b',
  selectionBackground: '#3a3833',
};

export function TerminalDrawer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const hosts = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const terms = useRef<Map<string, { term: XTerm; fit: FitAddon }>>(new Map());

  // Load existing sessions (or open the first one) and subscribe to output.
  useEffect(() => {
    void window.alethic.terminalList().then((list) => {
      if (list.length === 0)
        void window.alethic.terminalCreate().then((s) => {
          setSessions([s]);
          setActive(s.id);
        });
      else {
        setSessions(list);
        setActive((cur) => cur ?? list[0]!.id);
      }
    });
    const offData = window.alethic.onTerminalData(({ id, data }) => {
      const entry = terms.current.get(id);
      if (entry) entry.term.write(data);
      else void window.alethic.terminalList().then(setSessions); // a new tab (e.g. Executor) appeared
    });
    const offExit = window.alethic.onTerminalExit(({ id }) =>
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, alive: false } : s))),
    );
    return () => {
      offData();
      offExit();
      for (const { term } of terms.current.values()) term.dispose();
      terms.current.clear();
    };
  }, []);

  // Instantiate an xterm for every session that has a host div but no terminal yet.
  useEffect(() => {
    for (const s of sessions) {
      const host = hosts.current.get(s.id);
      if (!host || terms.current.has(s.id)) continue;
      const term = new XTerm({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        theme: XTERM_THEME,
        cursorBlink: s.kind === 'shell',
        disableStdin: s.kind !== 'shell',
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
      if (s.kind === 'shell') {
        term.onData((d) => void window.alethic.terminalInput(s.id, d));
        term.onResize(({ cols, rows }) => void window.alethic.terminalResize(s.id, cols, rows));
      } else {
        term.write('\x1b[2m— read-only: the agent’s bash commands appear here —\x1b[0m\r\n');
      }
      terms.current.set(s.id, { term, fit });
    }
  }, [sessions]);

  // Fit the active terminal when it becomes visible.
  useEffect(() => {
    if (!active) return;
    const entry = terms.current.get(active);
    if (!entry) return;
    try {
      entry.fit.fit();
      window.alethic.terminalResize(active, entry.term.cols, entry.term.rows);
    } catch {
      /* not laid out */
    }
  }, [active, sessions.length]);

  const newTab = (): void => {
    void window.alethic.terminalCreate().then((s) => {
      setSessions((prev) => [...prev, s]);
      setActive(s.id);
    });
  };
  const killTab = (id: string): void => {
    void window.alethic.terminalKill(id);
    const remaining = sessions.filter((s) => s.id !== id);
    terms.current.get(id)?.term.dispose();
    terms.current.delete(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (active === id) setActive(remaining[0]?.id ?? null);
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 26,
        height: 260,
        zIndex: 40,
        background: '#1d1c19',
        borderTop: `1.5px solid ${T.line}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          background: '#26241f',
        }}
      >
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => setActive(s.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: T.mono,
              fontSize: 11,
              color: active === s.id ? '#fff' : '#9c968a',
              background: active === s.id ? '#3a3833' : 'transparent',
            }}
          >
            <span>{s.kind === 'executor' ? '▷ Executor' : s.title}</span>
            {s.kind === 'shell' && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  killTab(s.id);
                }}
                style={{ color: '#6f6a60' }}
              >
                ✕
              </span>
            )}
          </div>
        ))}
        <button
          onClick={newTab}
          style={{
            ...btnGhost,
            padding: '2px 9px',
            fontSize: 12,
            color: '#c9c3b6',
            borderColor: '#3a3833',
          }}
          title="New terminal"
        >
          ＋
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{
            ...btnGhost,
            padding: '2px 9px',
            fontSize: 11,
            color: '#c9c3b6',
            borderColor: '#3a3833',
          }}
        >
          ▾ hide
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            ref={(el) => {
              hosts.current.set(s.id, el);
            }}
            style={{
              position: 'absolute',
              inset: 0,
              padding: '6px 8px',
              display: active === s.id ? 'block' : 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}
