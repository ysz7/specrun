// SystemBanner — the app-level condition banners (Phase 11 task 2, Phase 2 task 1). Passive notices
// that never block the pyramid (decision 15/38): "Reconnect Claude" when an agent call fails auth
// (the map still reads without a token), a soft "rate limited" note, a dropped-connection note, a
// "this account can't reach that model" note, a one-time "not a git repository" note per project,
// and an "update available" line from the static update check (decision 33). Mounted once in the
// Workspace; talks only to window.alethic.
import { useEffect, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary } from '../shared/ui';
import { classifyAgentError } from '../shared/agentError';
import type { UpdateInfo } from '../entities/node';

export function SystemBanner({ projectRoot }: { projectRoot: string }): React.JSX.Element | null {
  const [authError, setAuthError] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [noModelAccess, setNoModelAccess] = useState(false);
  const [notGitRepo, setNotGitRepo] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    // Global agent-error listener: any task's error can flip the app into a degraded banner.
    const off = window.alethic.onAgentEvent((e) => {
      if (e.type !== 'error') return;
      const kind = classifyAgentError(e.message);
      if (kind === 'auth') setAuthError(true);
      else if (kind === 'rate-limit') setRateLimited(true);
      else if (kind === 'connection') setConnectionLost(true);
      else if (kind === 'no-access') setNoModelAccess(true);
    });
    // Static update check, once, on open (decision 33). Silent on failure.
    void window.alethic.checkForUpdate().then((u) => u.available && setUpdate(u));
    return off;
  }, []);

  // Git-dependent features (drift, the Git panel) quietly fall back to file timestamps when the
  // project isn't a repo — a one-time note per project says so instead of leaving it unexplained.
  useEffect(() => {
    setNotGitRepo(false);
    void window.alethic.gitStatus().then((s) => s === null && setNotGitRepo(true));
  }, [projectRoot]);

  // A rate-limit note fades on its own; the SDK already auto-reduces concurrency (decision 9).
  useEffect(() => {
    if (!rateLimited) return;
    const t = setTimeout(() => setRateLimited(false), 20000);
    return () => clearTimeout(t);
  }, [rateLimited]);

  const reconnect = (): void => {
    const key = apiKey.trim();
    if (!key) return;
    setReconnecting(true);
    void window.alethic.setApiKey(key).then((s) => {
      setReconnecting(false);
      if (s.connected) {
        setAuthError(false);
        setApiKey('');
      }
    });
  };

  if (!authError && !rateLimited && !connectionLost && !noModelAccess && !notGitRepo && !update)
    return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 44,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 'min(560px, calc(100vw - 32px))',
        pointerEvents: 'none',
      }}
    >
      {authError && (
        <Shell tone="orange">
          <div style={{ pointerEvents: 'auto', width: '100%' }}>
            <div style={{ fontSize: 12.5, color: T.ink, fontWeight: 550 }}>Reconnect Claude</div>
            <div style={{ fontSize: 12, color: T.sub, margin: '3px 0 8px', lineHeight: 1.5 }}>
              Your Claude session expired. The map and local features keep working — reconnect to
              run the agent again. Sign in with Claude Code, or paste an Anthropic API key.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && reconnect()}
                placeholder="Anthropic API key"
                type="password"
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: '6px 8px',
                  borderRadius: 7,
                  border: `1.5px solid ${T.line}`,
                  background: T.card,
                  color: T.ink,
                  outline: 'none',
                }}
              />
              <button
                onClick={reconnect}
                disabled={reconnecting || !apiKey.trim()}
                style={{
                  ...btnPrimary,
                  padding: '6px 12px',
                  opacity: reconnecting || !apiKey.trim() ? 0.5 : 1,
                }}
              >
                {reconnecting ? 'Connecting…' : 'Reconnect'}
              </button>
              <button
                onClick={() => setAuthError(false)}
                style={{ ...btnGhost, padding: '6px 10px' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </Shell>
      )}

      {rateLimited && (
        <Shell tone="orange">
          <span style={{ pointerEvents: 'auto', fontSize: 12, color: T.ink }}>
            ⏳ Claude is rate-limited — agent runs slow down automatically. This clears shortly.
          </span>
          <span
            onClick={() => setRateLimited(false)}
            style={{ pointerEvents: 'auto', cursor: 'pointer', color: T.faint, marginLeft: 'auto' }}
          >
            ✕
          </span>
        </Shell>
      )}

      {connectionLost && (
        <Shell tone="orange">
          <span style={{ pointerEvents: 'auto', fontSize: 12, color: T.ink }}>
            ⚠ Couldn't reach Claude — check your internet connection and try again from the chat.
          </span>
          <span
            onClick={() => setConnectionLost(false)}
            style={{ pointerEvents: 'auto', cursor: 'pointer', color: T.faint, marginLeft: 'auto' }}
          >
            ✕
          </span>
        </Shell>
      )}

      {noModelAccess && (
        <Shell tone="orange">
          <span style={{ pointerEvents: 'auto', fontSize: 12, color: T.ink }}>
            ⚠ This Claude account can't reach the selected model — pick a different one from the
            model menu in the chat composer.
          </span>
          <span
            onClick={() => setNoModelAccess(false)}
            style={{ pointerEvents: 'auto', cursor: 'pointer', color: T.faint, marginLeft: 'auto' }}
          >
            ✕
          </span>
        </Shell>
      )}

      {notGitRepo && (
        <Shell tone="plain">
          <span style={{ pointerEvents: 'auto', fontSize: 12, color: T.ink }}>
            This folder isn't a git repository — change tracking falls back to file timestamps,
            which is coarser. Run <code style={{ fontFamily: T.mono }}>git init</code> for precise
            drift detection and the Git panel.
          </span>
          <span
            onClick={() => setNotGitRepo(false)}
            style={{ pointerEvents: 'auto', cursor: 'pointer', color: T.faint, marginLeft: 'auto' }}
          >
            ✕
          </span>
        </Shell>
      )}

      {update && (
        <Shell tone="plain">
          <span style={{ pointerEvents: 'auto', fontSize: 12, color: T.ink }}>
            ↑ Alethic {update.latest} is available (you have {update.current}).
          </span>
          {update.url && (
            <button
              onClick={() => update.url && void window.alethic.openExternal(update.url)}
              style={{ ...btnGhost, pointerEvents: 'auto', padding: '4px 10px', fontSize: 11.5 }}
              title="Open the download page in your browser"
            >
              Download
            </button>
          )}
          <span
            onClick={() => setUpdate(null)}
            style={{ pointerEvents: 'auto', cursor: 'pointer', color: T.faint, marginLeft: 'auto' }}
          >
            ✕
          </span>
        </Shell>
      )}
    </div>
  );
}

function Shell({
  tone,
  children,
}: {
  tone: 'orange' | 'plain';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderRadius: 10,
        background: T.card,
        border: `1.5px solid ${tone === 'orange' ? T.orange : T.line}`,
        boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
      }}
    >
      {children}
    </div>
  );
}
