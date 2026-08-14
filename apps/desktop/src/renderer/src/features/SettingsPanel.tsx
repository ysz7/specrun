// SettingsPanel — the one place to manage the app (Phase 11 polish, requested): the connected
// Claude account + API key, what the agent may do without asking (decision 1), the app version +
// update check, and a door to the run-log diagnostics.
// A modal overlay like DiagnosticsPanel; talks only to window.alethic.
import { useEffect, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary } from '../shared/ui';
import type { AuthStatus, SessionGrants, UpdateInfo } from '../entities/node';

interface SettingsPanelProps {
  onClose: () => void;
  onOpenDiagnostics: () => void;
}

export function SettingsPanel({
  onClose,
  onOpenDiagnostics,
}: SettingsPanelProps): React.JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [grants, setGrants] = useState<SessionGrants | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void window.alethic.authStatus().then(setAuth);
    void window.alethic.sessionGrants().then(setGrants);
    void window.alethic.checkForUpdate().then(setUpdate); // also gives us the current version
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Browser OAuth via the Claude Code CLI. Opens the browser, then polls until signed in — the
  // Agent SDK reads the CLI credential store on its next call, so no app restart is needed.
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

  const saveKey = (): void => {
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true);
    void window.alethic.setApiKey(key).then((s) => {
      setAuth(s);
      setApiKey('');
      setBusy(false);
    });
  };
  const disconnect = (): void => {
    setBusy(true);
    void window.alethic.disconnect().then((s) => {
      setAuth(s);
      setBusy(false);
    });
  };
  const checkUpdates = (): void => {
    setChecking(true);
    void window.alethic.checkForUpdate().then((u) => {
      setUpdate(u);
      setChecking(false);
    });
  };
  const copyDiagnostics = (): void => {
    void window.alethic.collectDiagnostics().then((text) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    });
  };

  const connected = auth?.connected ?? false;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(35,34,30,0.35)',
        display: 'grid',
        placeItems: 'center',
        fontFamily: T.sans,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, calc(100vw - 48px))',
          maxHeight: 'calc(100% - 64px)',
          overflowY: 'auto',
          background: T.paper,
          border: `1.5px solid ${T.line}`,
          borderRadius: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 18px',
            borderBottom: `1.5px solid ${T.lineSoft}`,
          }}
        >
          <span style={{ fontFamily: T.serif, fontSize: 16, fontWeight: 600, color: T.ink }}>
            Settings
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ ...btnGhost, padding: '6px 10px', fontSize: 12 }}>
            ✕
          </button>
        </div>

        <div style={{ padding: '18px 18px 22px' }}>
          {/* ── Claude account ── */}
          <Section title="Claude account">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 99,
                  background: connected ? T.green : T.faint,
                }}
              />
              <span style={{ fontSize: 13, color: T.ink }}>
                {connected
                  ? auth?.method === 'oauth'
                    ? `Connected with Claude Code${auth.email ? ` — ${auth.email}` : ''}${auth.plan ? ` (${auth.plan})` : ''}`
                    : 'Connected with an API key'
                  : 'Not connected'}
              </span>
              <span style={{ flex: 1 }} />
              {connected && (
                <button
                  onClick={disconnect}
                  disabled={busy}
                  style={{ ...btnGhost, padding: '6px 12px', fontSize: 12 }}
                >
                  Disconnect
                </button>
              )}
            </div>

            {!connected && (
              <>
                <button
                  onClick={connectClaudeCode}
                  disabled={signingIn || auth?.cliAvailable === false}
                  style={{
                    ...btnPrimary,
                    width: '100%',
                    padding: '11px 14px',
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
                {auth?.cliAvailable === false && (
                  <div style={{ fontSize: 11.5, color: T.orange, marginTop: 6 }}>
                    Claude Code CLI not found. Install it, or use an API key below.
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    margin: '14px 0 10px',
                    color: T.faint,
                    fontFamily: T.mono,
                    fontSize: 10,
                  }}
                >
                  <span style={{ flex: 1, height: 1, background: T.lineSoft }} />
                  OR
                  <span style={{ flex: 1, height: 1, background: T.lineSoft }} />
                </div>
              </>
            )}

            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                color: T.faint,
                letterSpacing: 1,
                marginBottom: 6,
              }}
            >
              {connected ? 'REPLACE WITH AN API KEY' : 'ANTHROPIC API KEY'}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                placeholder="sk-ant-…"
                type="password"
                style={{
                  flex: 1,
                  fontSize: 12.5,
                  padding: '9px 10px',
                  borderRadius: 8,
                  border: `1.5px solid ${T.line}`,
                  background: T.card,
                  color: T.ink,
                  outline: 'none',
                }}
              />
              <button
                onClick={saveKey}
                disabled={busy || !apiKey.trim()}
                style={{
                  ...btnPrimary,
                  padding: '9px 14px',
                  opacity: busy || !apiKey.trim() ? 0.5 : 1,
                }}
              >
                Save
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.5, marginTop: 8 }}>
              The API key is stored encrypted in your OS keychain, never in the project. Claude Code
              sign-in opens your browser and takes effect immediately — no restart needed.
            </div>
          </Section>

          {/* ── Permissions (decision 1) ── */}
          <Section title="Permissions">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                fontSize: 13,
                color: T.ink,
              }}
            >
              <input
                type="checkbox"
                checked={grants?.autoAcceptEdits ?? false}
                onChange={(e) =>
                  void window.alethic.setAutoAcceptEdits(e.target.checked).then(setGrants)
                }
                style={{ width: 15, height: 15, accentColor: T.blue, cursor: 'pointer' }}
              />
              Auto-accept edits
              {grants && (
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint }}>
                  {grants.editTools.join(' · ')}
                </span>
              )}
            </label>
            <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.5, marginTop: 8 }}>
              The agent asks before every file edit and every command, like Claude Code. With this
              on, edits go through unasked — commands still ask. It lasts for this session and turns
              off when you open another project.
            </div>

            {grants && grants.tools.length > 0 && (
              <>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9.5,
                    color: T.faint,
                    letterSpacing: 1,
                    margin: '14px 0 6px',
                  }}
                >
                  ALLOWED FOR THIS SESSION
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {grants.tools.map((tool) => (
                    <span
                      key={tool}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontFamily: T.mono,
                        fontSize: 11,
                        padding: '4px 6px 4px 9px',
                        borderRadius: 7,
                        background: T.bg,
                        border: `1px solid ${T.lineSoft}`,
                        color: T.ink,
                      }}
                    >
                      {tool}
                      <span
                        onClick={() => void window.alethic.revokeGrant(tool).then(setGrants)}
                        title={`Ask again before every ${tool}`}
                        style={{ cursor: 'pointer', color: T.faint }}
                      >
                        ✕
                      </span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Section>

          {/* ── Application ── */}
          <Section title="Application">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: T.ink }}>
                Alethic <b>{update?.current ?? '…'}</b>
              </span>
              <span style={{ flex: 1 }} />
              <button
                onClick={checkUpdates}
                disabled={checking}
                style={{ ...btnGhost, padding: '6px 12px', fontSize: 12 }}
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
            {update && (
              <div
                style={{ fontSize: 12, color: update.available ? T.orange : T.sub, marginTop: 8 }}
              >
                {update.available ? (
                  <>
                    Version {update.latest} is available.{' '}
                    {update.url && (
                      <span
                        onClick={() => update.url && void window.alethic.openExternal(update.url)}
                        style={{ color: T.blue, cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        Download
                      </span>
                    )}
                  </>
                ) : (
                  'You’re on the latest version.'
                )}
              </div>
            )}
          </Section>

          {/* ── Diagnostics ── */}
          <Section title="Diagnostics" last>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => {
                  onClose();
                  onOpenDiagnostics();
                }}
                style={{ ...btnGhost, padding: '8px 14px', fontSize: 12.5 }}
              >
                Open run logs
              </button>
              <button
                onClick={copyDiagnostics}
                style={{ ...btnGhost, padding: '8px 14px', fontSize: 12.5 }}
              >
                {copied ? '✓ Copied' : 'Copy diagnostics'}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: T.sub, lineHeight: 1.5, marginTop: 8 }}>
              No telemetry leaves your machine. Diagnostics copies version, OS, connection state and
              recent run metadata to the clipboard for support.
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  last,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: last ? 0 : 22 }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.2,
          textTransform: 'uppercase',
          color: T.faint,
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
