// GitPanel — the left source-control panel (planning-round decision): branch, staged/unstaged/
// untracked with stage/unstage, per-file diff, commit, push/pull — all via simple-git in main.
// Alethic never commits on its own; every write here is an explicit click, including `.alethic/`.
import { useEffect, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary } from '../shared/ui';
import type { GitStatus } from '../entities/node';

export function GitPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ file: string; patch: string } | null>(null);

  const refresh = (): void => void window.alethic.gitStatus().then(setStatus);
  useEffect(refresh, []);

  const run = (p: Promise<unknown>): void => {
    setBusy(true);
    void p.then(refresh).finally(() => setBusy(false));
  };
  const showDiff = (file: string, staged: boolean): void => {
    void window.alethic.gitFileDiff(file, staged).then((d) => setOpen({ file, patch: d.patch }));
  };

  const canCommit = !!status?.staged.length && message.trim().length > 0 && !busy;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        bottom: 26,
        left: 0,
        width: 300,
        zIndex: 35,
        background: T.paper,
        borderRight: `1.5px solid ${T.lineSoft}`,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          borderBottom: `1.5px solid ${T.lineSoft}`,
        }}
      >
        <span style={{ fontFamily: T.serif, fontSize: 14, fontWeight: 600, color: T.ink }}>
          Source control
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...btnGhost, padding: '4px 9px', fontSize: 11 }}>
          ✕
        </button>
      </div>

      {!status ? (
        <div style={{ padding: '20px 16px', color: T.sub, fontSize: 12.5, lineHeight: 1.6 }}>
          <div style={{ fontSize: 22, marginBottom: 6 }}>⑃</div>
          <div style={{ color: T.ink, fontWeight: 550, marginBottom: 4 }}>Not a git repository</div>
          <div>
            This folder isn’t under version control, so there’s nothing to stage or commit. Alethic
            still tracks drift by file timestamps. Run <code style={mono}>git init</code> in the
            terminal to enable source control here.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: T.mono,
              fontSize: 11,
            }}
          >
            <span style={{ color: T.orange }}>⑃ {status.branch}</span>
            {status.ahead > 0 && <span style={{ color: T.sub }}>↑{status.ahead}</span>}
            {status.behind > 0 && <span style={{ color: T.sub }}>↓{status.behind}</span>}
            <span style={{ flex: 1 }} />
            <button onClick={() => run(window.alethic.gitPull())} style={pill} title="Pull">
              ↓ pull
            </button>
            <button onClick={() => run(window.alethic.gitPush())} style={pill} title="Push">
              ↑ push
            </button>
          </div>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            style={{
              width: '100%',
              minHeight: 48,
              marginTop: 12,
              fontSize: 12.5,
              padding: '8px 10px',
              borderRadius: 8,
              border: `1.5px solid ${T.line}`,
              background: T.card,
              color: T.ink,
              outline: 'none',
              resize: 'vertical',
            }}
          />
          <button
            onClick={() => {
              run(window.alethic.gitCommit(message));
              setMessage('');
            }}
            disabled={!canCommit}
            style={{
              ...btnPrimary,
              width: '100%',
              marginTop: 8,
              padding: '8px',
              opacity: canCommit ? 1 : 0.5,
            }}
          >
            ✓ Commit {status.staged.length ? `(${status.staged.length})` : ''}
          </button>

          <Section
            title="Staged"
            files={status.staged}
            onFile={(f) => showDiff(f, true)}
            action={(f) => (
              <FileBtn
                label="−"
                title="Unstage"
                onClick={() => run(window.alethic.gitUnstage([f]))}
              />
            )}
          />
          <Section
            title="Changes"
            files={status.unstaged}
            onFile={(f) => showDiff(f, false)}
            action={(f) => (
              <FileBtn label="+" title="Stage" onClick={() => run(window.alethic.gitStage([f]))} />
            )}
          />
          <Section
            title="Untracked"
            files={status.untracked}
            onFile={(f) => showDiff(f, false)}
            action={(f) => (
              <FileBtn label="+" title="Stage" onClick={() => run(window.alethic.gitStage([f]))} />
            )}
          />
          {status.clean && (
            <div style={{ color: T.sub, fontSize: 12, marginTop: 14 }}>Working tree clean.</div>
          )}
        </div>
      )}

      {open && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: T.paper,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderBottom: `1.5px solid ${T.lineSoft}`,
            }}
          >
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink }}>{open.file}</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setOpen(null)}
              style={{ ...btnGhost, padding: '4px 9px', fontSize: 11 }}
            >
              ✕
            </button>
          </div>
          <pre
            style={{
              flex: 1,
              overflow: 'auto',
              margin: 0,
              padding: '10px 12px',
              fontFamily: T.mono,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {open.patch.split('\n').map((line, i) => (
              <div
                key={i}
                style={{
                  color: line.startsWith('+')
                    ? T.green
                    : line.startsWith('-')
                      ? T.orange
                      : line.startsWith('@@')
                        ? T.blue
                        : T.ink,
                }}
              >
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

const mono: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 11,
  color: T.orange,
  background: T.orangeSoft,
  padding: '1px 4px',
  borderRadius: 4,
};

const pill: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 10.5,
  color: T.sub,
  background: T.card,
  border: `1.5px solid ${T.line}`,
  borderRadius: 6,
  padding: '2px 7px',
  cursor: 'pointer',
};

function Section({
  title,
  files,
  action,
  onFile,
}: {
  title: string;
  files: string[];
  action: (f: string) => React.JSX.Element;
  onFile: (f: string) => void;
}): React.JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9.5,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: T.faint,
          marginBottom: 4,
        }}
      >
        {title} · {files.length}
      </div>
      {files.map((f) => (
        <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
          <span
            onClick={() => onFile(f)}
            style={{
              flex: 1,
              fontFamily: T.mono,
              fontSize: 11,
              color: T.ink,
              cursor: 'pointer',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={f}
          >
            {f}
          </span>
          {action(f)}
        </div>
      ))}
    </div>
  );
}

function FileBtn({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontFamily: T.mono,
        fontSize: 13,
        width: 20,
        height: 20,
        lineHeight: '16px',
        color: T.sub,
        background: T.card,
        border: `1.5px solid ${T.line}`,
        borderRadius: 5,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
