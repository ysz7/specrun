// Welcome — the single onboarding screen (Act 0, decision 31): Connect Claude → choose a folder →
// auto-branch by what's inside (code → Scan, empty → Start building, mapped → the map; the branching
// itself lives in App/ScanFlow). Connecting is encouraged but never blocks: the map and local
// features read without a token (decision 38), so "Open folder" is always live.
import { useEffect, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { btnPrimary } from '../shared/ui';
import type { AuthStatus, RecentProject } from '../entities/node';

interface WelcomeProps {
  onOpen: (dir: string) => void;
  onPick: () => void;
}

export function Welcome({ onOpen, onPick }: WelcomeProps): React.JSX.Element {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void window.alethic.recentProjects().then(setRecent);
    void window.alethic.authStatus().then(setAuth);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const connect = (): void => {
    const key = apiKey.trim();
    if (!key) return;
    setConnecting(true);
    void window.alethic.setApiKey(key).then((s) => {
      setAuth(s);
      setApiKey('');
      setConnecting(false);
    });
  };

  // Browser OAuth via Claude Code — opens the browser, then polls until signed in (no restart).
  const connectClaudeCode = (): void => {
    setSigningIn(true);
    void window.alethic.loginClaudeCode();
    let waited = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      waited += 2;
      void window.alethic.authStatus().then((s) => {
        if (s.connected) {
          setAuth(s);
          setSigningIn(false);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      });
      if (waited >= 180) {
        setSigningIn(false);
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 2000);
  };

  const connected = auth?.connected ?? false;

  return (
    <div
      style={{
        height: '100%',
        background: T.bg,
        display: 'grid',
        placeItems: 'center',
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          background: T.card,
          border: `1.5px solid ${T.line}`,
          borderRadius: 14,
          padding: '30px 30px',
          boxShadow: '0 2px 12px rgba(35,34,30,0.06)',
        }}
      >
        <div style={{ fontFamily: T.serif, fontSize: 24, fontWeight: 600, color: T.ink }}>
          Alethic
        </div>
        <div style={{ width: 36, height: 2, background: T.orange, margin: '10px 0 0' }} />
        <div style={{ fontSize: 13, color: T.sub, lineHeight: 1.6, marginTop: 14 }}>
          Open a project to see the living map of its logic. A folder without a map yet is offered a
          scan; an empty one starts a new build.
        </div>

        {/* Step 1 — Connect Claude */}
        <div style={{ marginTop: 22 }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, letterSpacing: 1.2 }}>
            1 · CONNECT CLAUDE
          </div>
          {connected ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 8,
                padding: '9px 12px',
                borderRadius: 9,
                border: `1.5px solid ${T.greenSoft}`,
                background: T.greenSoft,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 99, background: T.green }} />
              <span style={{ fontSize: 12.5, color: T.ink }}>
                {auth?.method === 'oauth'
                  ? `Claude connected${auth.email ? ` — ${auth.email}` : ''}${auth.plan ? ` (${auth.plan})` : ''}`
                  : 'Claude connected (API key).'}
              </span>
              <span style={{ flex: 1 }} />
              <span
                onClick={() => void window.alethic.disconnect().then(setAuth)}
                style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint, cursor: 'pointer' }}
              >
                disconnect
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.5, marginBottom: 8 }}>
                Sign in with your Claude subscription, or paste an Anthropic API key. You can also
                skip this and just read the map — Claude is needed only to scan, sync, plan or
                build.
              </div>
              <button
                onClick={connectClaudeCode}
                disabled={signingIn || auth?.cliAvailable === false}
                style={{
                  ...btnPrimary,
                  width: '100%',
                  padding: '10px 14px',
                  marginBottom: 8,
                  opacity: signingIn || auth?.cliAvailable === false ? 0.6 : 1,
                }}
                title={
                  auth?.cliAvailable === false
                    ? 'The Claude Code CLI was not found on PATH'
                    : 'Opens your browser to sign in with your Claude subscription'
                }
              >
                {signingIn ? 'Waiting for browser sign-in…' : '🌐 Connect with Claude Code'}
              </button>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connect()}
                  placeholder="Anthropic API key"
                  type="password"
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    padding: '9px 10px',
                    borderRadius: 8,
                    border: `1.5px solid ${T.line}`,
                    background: T.paper,
                    color: T.ink,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={connect}
                  disabled={connecting || !apiKey.trim()}
                  style={{
                    ...btnPrimary,
                    padding: '9px 14px',
                    opacity: connecting || !apiKey.trim() ? 0.5 : 1,
                  }}
                >
                  {connecting ? '…' : 'Connect'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Step 2 — Choose a folder */}
        <div style={{ marginTop: 22 }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, letterSpacing: 1.2 }}>
            2 · CHOOSE A FOLDER
          </div>
          <button
            onClick={onPick}
            style={{
              ...btnPrimary,
              width: '100%',
              marginTop: 8,
              padding: '13px 16px',
              fontSize: 14.5,
            }}
          >
            Open folder…
          </button>
        </div>

        {recent.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, letterSpacing: 1.2 }}>
              RECENT
            </div>
            {recent.map((r) => (
              <div
                key={r.path}
                onClick={() => onOpen(r.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 12px',
                  borderRadius: 9,
                  border: `1.5px solid ${T.lineSoft}`,
                  background: T.paper,
                  cursor: 'pointer',
                  marginTop: 8,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 550, color: T.ink, flex: 1 }}>
                  {r.name}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.faint }}>{r.path}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
