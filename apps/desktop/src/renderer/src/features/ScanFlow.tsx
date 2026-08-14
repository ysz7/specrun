// ScanFlow — Act 1 in the UI: a free cost preview, the domain-confirmation screen (rename / edit
// scope / delete / choose deep, decision 6), then the scan with a ticking counter while the pyramid
// grows behind it. Cancelling keeps whatever was already scanned (decision 36).
import { useEffect, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary } from '../shared/ui';
import type { DomainProposal, ScanPreview, ScanProgress } from '../entities/node';

type Step = 'preview' | 'confirm' | 'running';

export function ScanFlow({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [step, setStep] = useState<Step>('preview');
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [domains, setDomains] = useState<DomainProposal[]>([]);
  const [deep, setDeep] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('claude-sonnet-5');
  const [desc, setDesc] = useState('');
  const [mode, setMode] = useState<'dev' | 'plan'>('plan'); // empty folder defaults to planning
  const [modeTouched, setModeTouched] = useState(false); // user overrode the auto-guess
  const greenfield = !!preview && preview.files === 0; // empty folder → Act 3, decision 29

  // Auto-guess the mode from the description until the user picks one (decision 54).
  useEffect(() => {
    if (modeTouched) return;
    setMode(looksLikeSoftware(desc) ? 'dev' : 'plan');
  }, [desc, modeTouched]);

  const startBuilding = (): void => {
    if (!desc.trim()) return;
    setBusy(true);
    void window.alethic.startBuilding(desc.trim(), model, mode).then(() => setTimeout(onDone, 400));
  };

  useEffect(() => {
    void window.alethic.scanPreview().then((p) => {
      setPreview(p);
      setDomains(p.domains);
      setDeep(new Set(p.large ? [] : p.domains.map((d) => d.slug)));
    });
    void window.alethic.listModels().then((m) => m[0] && setModel(m[0].id));
    return window.alethic.onScanProgress((p) => {
      setProgress(p);
      if (p.phase === 'done' || p.phase === 'cancelled') setTimeout(onDone, 600);
    });
  }, [onDone]);

  const propose = async (): Promise<void> => {
    setBusy(true);
    try {
      const proposed = await window.alethic.scanDecompose(model);
      setDomains(proposed);
      setDeep(new Set(preview?.large ? [] : proposed.map((d) => d.slug)));
    } finally {
      setBusy(false);
      setStep('confirm');
    }
  };

  const edit = (i: number, patch: Partial<DomainProposal>): void =>
    setDomains((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  const start = (): void => {
    setStep('running');
    void window.alethic.scanStart(model, domains, [...deep]);
  };

  const card: React.CSSProperties = {
    width: 'min(560px, calc(100vw - 48px))',
    background: T.card,
    border: `1.5px solid ${T.line}`,
    borderRadius: 14,
    padding: '26px 28px',
    boxShadow: '0 2px 12px rgba(35,34,30,0.06)',
  };

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
      <div style={card}>
        <div style={{ fontFamily: T.serif, fontSize: 22, fontWeight: 600, color: T.ink }}>
          {step === 'running'
            ? 'Scanning…'
            : greenfield
              ? 'Start building'
              : 'Scan this repository'}
        </div>
        <div style={{ width: 36, height: 2, background: T.orange, margin: '10px 0 16px' }} />

        {step === 'preview' && greenfield && (
          <>
            <div style={{ fontSize: 13.5, color: T.ink, lineHeight: 1.7, marginBottom: 12 }}>
              This folder is empty. Describe what you want to do — Alethic will either build
              software (code) or help you plan something (a trip, a recipe, a business idea).
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {(['plan', 'dev'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setModeTouched(true);
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    borderRadius: 9,
                    fontSize: 12.5,
                    fontWeight: 550,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: mode === m ? T.ink : T.sub,
                    background: mode === m ? T.orangeSoft : T.paper,
                    border: `1.5px solid ${mode === m ? T.orange : T.line}`,
                  }}
                >
                  {m === 'plan' ? '📝 Plan something' : '⚙ Build software'}
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11,
                      fontWeight: 400,
                      color: T.faint,
                      marginTop: 2,
                    }}
                  >
                    {m === 'plan' ? 'notes & content, no code' : 'code, rules, executable steps'}
                  </span>
                </button>
              ))}
            </div>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={
                mode === 'plan'
                  ? 'e.g. A 5-day trip to Tuscany with a fish-dinner recipe for the last night.'
                  : 'e.g. A CLI todo app in TypeScript with add/list/done commands and JSON storage.'
              }
              style={{
                width: '100%',
                boxSizing: 'border-box',
                minHeight: 96,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '10px 12px',
                borderRadius: 9,
                border: `1.5px solid ${T.line}`,
                background: T.paper,
                color: T.ink,
                outline: 'none',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                onClick={startBuilding}
                disabled={busy || !desc.trim()}
                style={{ ...btnPrimary, opacity: busy || !desc.trim() ? 0.5 : 1 }}
              >
                {busy ? 'Starting…' : mode === 'plan' ? 'Start planning' : 'Start building'}
              </button>
            </div>
          </>
        )}

        {step === 'preview' && !greenfield && (
          <>
            {!preview ? (
              <div style={{ color: T.sub, fontSize: 13 }}>
                Reading the repository (free, no tokens)…
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13.5, color: T.ink, lineHeight: 1.7 }}>
                  <div>
                    <b>{preview.files}</b> source files · <b>{preview.domains.length}</b> domain
                    candidates
                  </div>
                  <div style={{ color: T.sub }}>
                    Estimated cost: ~<b>{preview.estimatedCalls}</b> agent calls.
                  </div>
                </div>
                {preview.large && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '10px 12px',
                      borderRadius: 9,
                      background: T.orangeSoft,
                      border: '1.5px solid rgba(217,98,43,0.3)',
                      fontSize: 12.5,
                      color: T.ink,
                    }}
                  >
                    Large repository (over {preview.threshold} files). Pick which domains to scan
                    deeply — the rest are scanned shallowly. Coverage stays 100% either way.
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                  <button
                    onClick={() => void propose()}
                    disabled={busy}
                    style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}
                  >
                    {busy ? 'Proposing…' : 'Propose domains (1 call)'}
                  </button>
                  <button onClick={() => setStep('confirm')} style={btnGhost}>
                    Use the detected ones
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {step === 'confirm' && (
          <>
            <div style={{ fontSize: 13, color: T.sub, marginBottom: 12 }}>
              Confirm the domains. Rename, adjust scope, drop what isn’t a domain
              {preview?.large ? ', and tick the ones worth a deep scan' : ''}.
            </div>
            <div
              style={{
                maxHeight: '42vh',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {domains.map((d, i) => (
                <div
                  key={`${d.slug}-${i}`}
                  style={{
                    border: `1.5px solid ${T.lineSoft}`,
                    borderRadius: 9,
                    padding: '9px 11px',
                    background: T.paper,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {preview?.large && (
                      <input
                        type="checkbox"
                        checked={deep.has(d.slug)}
                        onChange={(e) =>
                          setDeep((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(d.slug);
                            else next.delete(d.slug);
                            return next;
                          })
                        }
                        title="Deep scan"
                      />
                    )}
                    <input
                      value={d.title}
                      onChange={(e) => edit(i, { title: e.target.value })}
                      style={{
                        flex: 1,
                        fontSize: 13.5,
                        fontWeight: 550,
                        border: 'none',
                        background: 'transparent',
                        color: T.ink,
                        outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => setDomains((prev) => prev.filter((_, idx) => idx !== i))}
                      style={{ ...btnGhost, padding: '3px 8px', fontSize: 11 }}
                    >
                      remove
                    </button>
                  </div>
                  <input
                    value={d.scope.join(', ')}
                    onChange={(e) =>
                      edit(i, {
                        scope: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    style={{
                      width: '100%',
                      marginTop: 4,
                      fontFamily: T.mono,
                      fontSize: 11,
                      color: T.faint,
                      border: 'none',
                      background: 'transparent',
                      outline: 'none',
                    }}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button
                onClick={start}
                disabled={domains.length === 0}
                style={{ ...btnPrimary, opacity: domains.length ? 1 : 0.5 }}
              >
                Start scan ({domains.length} domains)
              </button>
              <button onClick={() => setStep('preview')} style={btnGhost}>
                Back
              </button>
            </div>
          </>
        )}

        {step === 'running' && (
          <>
            <div style={{ fontSize: 13.5, color: T.ink }}>
              {progress?.phase === 'cancelled'
                ? 'Cancelled — everything already scanned was kept.'
                : `${progress?.completed ?? 0} / ${progress?.total ?? domains.length} domains`}
              {progress?.domain ? <span style={{ color: T.sub }}> · {progress.domain}</span> : null}
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 99,
                background: T.lineSoft,
                marginTop: 12,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.round(((progress?.completed ?? 0) / Math.max(1, progress?.total ?? domains.length)) * 100)}%`,
                  background: T.orange,
                  transition: 'width 0.3s',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: T.sub, marginTop: 10 }}>
              {progress?.phase === 'scanning' && progress.message
                ? // A pulse from inside the current domain (a file being read, a running feature
                  // count) — `completed` alone only moves when a whole domain lands, which on a
                  // ten-domain repo can sit at "0 / 10" for minutes of real work and read as a hang.
                  progress.message
                : 'The pyramid grows as domains land. You can cancel — scanned domains stay.'}
            </div>
            <button
              onClick={() => void window.alethic.scanCancel()}
              style={{ ...btnGhost, marginTop: 16 }}
            >
              Cancel scan
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Heuristic default for the greenfield mode toggle (decision 54): does the description read like a
// software build? Empty folders otherwise default to plan mode.
const SOFTWARE_HINTS =
  /\b(app|application|cli|api|website|web ?app|service|library|package|backend|frontend|server|database|typescript|javascript|python|react|node|code|program|software|endpoint|component|function|repo|repository)\b/i;
function looksLikeSoftware(desc: string): boolean {
  return SOFTWARE_HINTS.test(desc);
}
