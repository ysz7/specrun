// NodeExpander — a node opened "from" (never "over"): full-screen view of a node with its
// statement, sections (Invariants / Edge cases / Drift log), anchors (click → code) and relations.
// In Phase 7 it grows drift resolution (Update spec from code / Mark as regression, decisions 14/28)
// and in-place editing of title + body (decision 16) with an on-disk conflict dialog (decision 17).
import { useEffect, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary, Tick } from '../shared/ui';
import { visualFor } from '../shared/status';
import { childrenOf, snapshotNode, type AtlasVm } from '../shared/viewmodel';
import { Markdown } from '../shared/markdown';
import { parsePlanPhases } from '../shared/plan';
import { useScanActivity } from '../shared/useScanActivity';
import type { Anchor, RuleMeta } from '../entities/node';

const MODEL = 'claude-sonnet-5';

interface NodeExpanderProps {
  vm: AtlasVm;
  nodeId: string;
  onClose: () => void;
  onOpenCode: (file: string, line: number) => void;
  onNavigate: (id: string) => void;
}

function sections(body: string): {
  statement: string;
  blocks: { heading: string; content: string }[];
} {
  const parts = body.split(/^##\s+/m);
  const statement = (parts[0] ?? '').trim();
  const blocks = parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    return {
      heading: (nl < 0 ? p : p.slice(0, nl)).trim(),
      content: (nl < 0 ? '' : p.slice(nl + 1)).trim(),
    };
  });
  return { statement, blocks };
}

export function NodeExpander({
  vm,
  nodeId,
  onClose,
  onOpenCode,
  onNavigate,
}: NodeExpanderProps): React.JSX.Element {
  const node = vm.byId.get(nodeId)!;
  const snap = snapshotNode(vm, nodeId);
  const meta = snap?.meta;
  const { statement, blocks } = sections(snap?.body ?? '');
  const visual = visualFor(node.status ?? node.rollup?.worst, node.flags);
  const anchors: Anchor[] =
    meta && (meta.kind === 'rule' || meta.kind === 'plan-step') ? meta.anchors : [];
  const affects = meta && meta.kind === 'rule' ? (meta as RuleMeta).affects : [];
  const affectedBy = vm.index.affected_by[nodeId] ?? [];

  const isRule = node.kind === 'rule';
  const drifting = node.status === 'drift' || node.status === 'stale';
  // A branch mapped before the unit became a feature (decision 56). The flag is deterministic, so
  // the offer to migrate appears exactly where the old form actually is — and a map still holding
  // it can never be silent about it (Phase 6).
  const isBranch = node.kind === 'domain' || node.kind === 'sub';
  const legacyChildren = isBranch
    ? childrenOf(vm, nodeId).filter((c) => c.flags.includes('legacy-form')).length
    : 0;
  // A scan pass owns the map while it runs, so the buttons that start one say so and stop offering.
  const scan = useScanActivity();
  const editable = !node.flags.includes('conflict') && node.kind !== 'plan-step';

  // ── editing (decision 16) + on-disk conflict (decision 17) ──
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(node.title);
  const [draftBody, setDraftBody] = useState(snap?.body ?? '');
  const [conflict, setConflict] = useState<{ title: string; body: string; updated: string } | null>(
    null,
  );
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // ── plan-phase execution (dev-planning v2, decision 55) ──
  const isPlan = node.kind === 'plan';
  const phases = isPlan ? parsePlanPhases(snap?.body ?? '') : [];
  const [phaseRun, setPhaseRun] = useState<
    Record<number, 'queued' | 'running' | 'mapping' | 'error'>
  >({});

  useEffect(() => {
    if (!isPlan) return;
    // Restore status for phases already queued/running (the view may have been closed & reopened
    // mid-run; progress events aren't replayed).
    void window.alethic.phaseStatus(nodeId).then(({ running, queued }) => {
      setPhaseRun((prev) => {
        const next = { ...prev };
        for (const i of queued) next[i] = 'queued';
        for (const i of running) next[i] = 'running';
        return next;
      });
    });
    return window.alethic.onPlanProgress((p) => {
      if (p.phaseIndex === undefined) return;
      setPhaseRun((prev) => {
        const next = { ...prev };
        if (p.phase === 'executing') next[p.phaseIndex!] = 'running';
        // The phase landed; the scanner is folding its code into the Code branch (decision 55).
        else if (p.phase === 'mapping') next[p.phaseIndex!] = 'mapping';
        else if (p.phase === 'done') delete next[p.phaseIndex!];
        else if (p.phase === 'blocked' || p.phase === 'error') next[p.phaseIndex!] = 'error';
        return next;
      });
    });
  }, [isPlan, nodeId]);

  const runPhase = (i: number): void => {
    setPhaseRun((prev) => ({ ...prev, [i]: 'queued' })); // queue it; runs sequentially (decision 25)
    void window.alethic.executePhase(nodeId, i, MODEL);
  };

  // Reset drafts whenever the live snapshot changes (e.g. a sync verdict lands).
  useEffect(() => {
    if (!editing) {
      setDraftTitle(node.title);
      setDraftBody(snap?.body ?? '');
    }
  }, [snap?.body, node.title, editing]);

  // Grow the borderless editor to fit its content, so it reads like the page (no inner scrollbar).
  useEffect(() => {
    const el = bodyRef.current;
    if (!editing || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draftBody]);

  const baseUpdated = meta?.updated;

  const save = async (force: boolean): Promise<void> => {
    const result = await window.alethic.saveNode({
      path: node.path,
      title: draftTitle,
      body: draftBody,
      ...(baseUpdated ? { expectedUpdated: baseUpdated } : {}),
      force,
    });
    if (result.conflict && !force) {
      setConflict({ title: result.title, body: result.body, updated: result.updated });
      return;
    }
    setConflict(null);
    setEditing(false);
  };

  const reloadFromDisk = (): void => {
    if (conflict) {
      setDraftTitle(conflict.title);
      setDraftBody(conflict.body);
    }
    setConflict(null);
    setEditing(false);
  };

  const RelRow = ({ id }: { id: string }): React.JSX.Element | null => {
    const target = vm.byId.get(id);
    if (!target) return null;
    const tv = visualFor(target.status ?? target.rollup?.worst, target.flags);
    return (
      <div
        onClick={() => onNavigate(id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 9,
          border: `1.5px solid ${T.lineSoft}`,
          background: T.card,
          cursor: 'pointer',
          marginTop: 7,
        }}
      >
        <Tick color={tv.dot} />
        <span style={{ fontSize: 12.5, fontWeight: 550, color: T.ink, flex: 1 }}>
          {target.title}
        </span>
        <span style={{ color: T.faint, fontSize: 12 }}>→</span>
      </div>
    );
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: T.paper,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
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
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>
          .alethic / {node.path}
        </span>
        {node.flags.includes('conflict') && (
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.orange }}>⚑ conflict</span>
        )}
        {node.flags.includes('deepened') && (
          <span
            style={{ fontFamily: T.mono, fontSize: 10, color: T.faint }}
            title="A Deepen pass has been through this node"
          >
            ⤓ deepened
          </span>
        )}
        {node.flags.includes('legacy-form') && (
          <span
            style={{ fontFamily: T.mono, fontSize: 10, color: T.orange }}
            title="Mapped before the unit became a feature (decision 56): the assertion is the title and the body is one line. Migrate the branch above it to fold these into features."
          >
            ⇪ old form
          </span>
        )}
        <span style={{ flex: 1 }} />
        {editing ? (
          // Save / Cancel sit exactly where Edit was, so entering edit mode barely shifts anything.
          <>
            <button onClick={() => void save(false)} style={{ ...btnPrimary, padding: '6px 14px' }}>
              Save
            </button>
            <button
              onClick={reloadFromDisk}
              style={{ ...btnGhost, padding: '6px 12px' }}
              title="Discard your edits"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {editable && (
              <button
                onClick={() => setEditing(true)}
                style={{ ...btnGhost, padding: '6px 12px' }}
                title="Edit the title and body (saved as a human edit)"
              >
                ✎ edit
              </button>
            )}
            {/* Offered before Deepen/Rescan: deepening a branch of sentence-shaped nodes only
                writes more of them, so the form comes first (Phase 6). */}
            {legacyChildren > 0 && (
              <ScanButton
                scanning={scan.running}
                busyLabel="⇪ migrating…"
                onClick={() => void window.alethic.migrateNode(nodeId, MODEL)}
                title={`${legacyChildren} node${legacyChildren === 1 ? '' : 's'} here still carry the assertion in the title and one line of body. Fold them into features, keeping their ids (snapshots .alethic first).`}
              >
                ⇪ migrate to features ({legacyChildren})
              </ScanButton>
            )}
            {node.path === 'domains/_section.md' ? (
              // The Code branch is derived from the code (decision 55) — rebuild it on demand.
              <ScanButton
                scanning={scan.running}
                busyLabel="⟳ reading the code…"
                onClick={() => void window.alethic.mapCode(MODEL)}
                title="Scan the code and bring the rules under this branch up to date"
              >
                ⟳ update code map
              </ScanButton>
            ) : node.kind === 'domain' ? (
              <ScanButton
                scanning={scan.running}
                busyLabel="⟳ rescanning…"
                onClick={() =>
                  void window.alethic.rescanDomain(node.path.split('/')[1] ?? '', MODEL)
                }
                title="Re-scan this domain (snapshots .alethic first)"
              >
                ⟳ rescan domain
              </ScanButton>
            ) : node.kind === 'note' ||
              node.kind === 'plan' ||
              node.kind === 'section' ||
              // a step from a pre-v2 map: readable, never executable (decision 55 replaced steps)
              node.kind === 'plan-step' ? null : ( // content, not code — no deepen
              <ScanButton
                scanning={scan.running}
                busyLabel="⤓ deepening…"
                onClick={() => void window.alethic.deepenNode(nodeId, MODEL)}
                title={
                  node.kind === 'rule'
                    ? 'Deepen: re-read this feature’s code and fill in how it works, where it is used, its invariants and edge cases (this node only)'
                    : 'Deepen: read the code under this branch and fill in the features it is missing'
                }
              >
                ⤓ deepen
              </ScanButton>
            )}
            <button onClick={onClose} style={{ ...btnGhost, padding: '6px 12px' }}>
              ✕ close
            </button>
          </>
        )}
      </div>

      {/* Scroller spans the full width so its scrollbar sits at the window's right edge (like a
          browser); the content column stays centered via the inner wrapper. */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', width: '100%' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', width: '100%', padding: '24px 22px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Tick color={visual.dot} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>{visual.label}</span>
          </div>
          {editing ? (
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              style={{
                fontFamily: T.serif,
                fontSize: 25,
                fontWeight: 600,
                color: T.ink,
                margin: '12px 0 0',
                width: '100%',
                border: 'none',
                borderBottom: `2px solid ${T.orange}`,
                background: 'transparent',
                outline: 'none',
              }}
            />
          ) : (
            <h1
              style={{
                fontFamily: T.serif,
                fontSize: 25,
                fontWeight: 600,
                color: T.ink,
                margin: '12px 0 0',
                lineHeight: 1.25,
              }}
            >
              {node.title}
            </h1>
          )}
          <div style={{ width: 42, height: 2, background: T.orange, margin: '14px 0 16px' }} />

          {/* Passive drift resolution (decisions 14/28) — offered, never forced (decision 15). */}
          {isRule && drifting && !editing && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <button
                onClick={() => void window.alethic.updateSpecFromCode(nodeId, MODEL)}
                style={{ ...btnGhost, padding: '7px 12px' }}
                title="Re-read the code and update this rule (locked rules get a proposed diff)"
              >
                ⤢ update spec from code
              </button>
              <button
                onClick={() => void window.alethic.markRegression(nodeId, MODEL)}
                style={{ ...btnGhost, padding: '7px 12px', color: T.orange, borderColor: T.orange }}
                title="Treat the code as a regression and draft a fix-plan"
              >
                ⚑ mark as regression
              </button>
            </div>
          )}

          {conflict && (
            <div
              style={{
                marginBottom: 16,
                padding: '12px 14px',
                border: `1.5px solid ${T.orange}`,
                borderRadius: 10,
                background: T.orangeSoft,
              }}
            >
              <div style={{ fontSize: 13, color: T.ink, marginBottom: 8 }}>
                This file changed on disk since you started editing. Reload to take the disk
                version, or overwrite it with your edits.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={reloadFromDisk} style={{ ...btnGhost, padding: '6px 12px' }}>
                  Reload
                </button>
                <button
                  onClick={() => void save(true)}
                  style={{ ...btnPrimary, padding: '6px 12px' }}
                >
                  Overwrite
                </button>
              </div>
            </div>
          )}

          {editing ? (
            <>
              {/* Borderless, body-styled editor: editing looks like the page, not a form field. */}
              <textarea
                ref={bodyRef}
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                spellCheck={false}
                autoFocus
                style={{
                  display: 'block',
                  width: '100%',
                  minHeight: '40vh',
                  fontFamily: T.sans,
                  fontSize: 14.5,
                  lineHeight: 1.7,
                  color: T.ink,
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  padding: 0,
                  margin: 0,
                  outline: 'none',
                  resize: 'none',
                  overflow: 'hidden', // grows to fit instead of scrolling inside a box
                }}
              />
            </>
          ) : node.flags.includes('conflict') ? (
            <pre
              style={{
                fontFamily: T.mono,
                fontSize: 12.5,
                lineHeight: 1.6,
                color: T.ink,
                background: T.card,
                border: `1.5px dashed ${T.orange}`,
                borderRadius: 10,
                padding: '12px 14px',
                whiteSpace: 'pre-wrap',
              }}
            >
              {snap?.body}
            </pre>
          ) : isPlan ? (
            // Dev-planning v2 (decision 55): the roadmap as phases, each with an execute button + status.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {statement.trim() && (
                <div style={{ fontSize: 14, color: T.sub }}>
                  <Markdown text={statement} />
                </div>
              )}
              {phases.map((ph) => {
                const st = phaseRun[ph.index];
                const itemsMd = ph.items
                  .map((it) => `- [${it.done ? 'x' : ' '}] ${it.text}`)
                  .join('\n');
                return (
                  <div
                    key={ph.index}
                    style={{
                      padding: '12px 15px',
                      border: `1.5px solid ${ph.done ? T.green : T.lineSoft}`,
                      borderRadius: 10,
                      background: T.card,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          flex: 1,
                          fontFamily: T.serif,
                          fontWeight: 600,
                          fontSize: 15,
                          color: T.ink,
                        }}
                      >
                        {ph.title}
                      </div>
                      {ph.done ? (
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.green }}>
                          ✓ done
                        </span>
                      ) : st === 'running' ? (
                        <span
                          style={{
                            fontFamily: T.mono,
                            fontSize: 11,
                            color: T.orange,
                            animation: 'alethicBlink 1.2s ease-in-out infinite',
                          }}
                        >
                          ● running…
                        </span>
                      ) : st === 'mapping' ? (
                        <span
                          style={{
                            fontFamily: T.mono,
                            fontSize: 11,
                            color: T.orange,
                            animation: 'alethicBlink 1.2s ease-in-out infinite',
                          }}
                          title="The phase landed — scanning the code it wrote into the Code branch"
                        >
                          ● mapping code…
                        </span>
                      ) : st === 'queued' ? (
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>
                          queued
                        </span>
                      ) : st === 'error' ? (
                        <span style={{ fontFamily: T.mono, fontSize: 11, color: '#B3452B' }}>
                          ⚠ check chat
                        </span>
                      ) : (
                        <button
                          onClick={() => runPhase(ph.index)}
                          style={{
                            ...btnGhost,
                            padding: '5px 11px',
                            color: T.orange,
                            borderColor: T.orange,
                          }}
                          title="Execute this phase (queues if others are running)"
                        >
                          ▶ execute phase
                        </button>
                      )}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 13.5, color: T.ink }}>
                      <Markdown text={itemsMd} />
                    </div>
                    {/* What the run produced, written into the plan itself (decision 55) — the
                      finished phase carries its own record instead of spawning a node file. */}
                    {ph.note && (
                      <div
                        style={{
                          marginTop: 8,
                          paddingTop: 8,
                          borderTop: `1px solid ${T.lineSoft}`,
                          fontFamily: T.mono,
                          fontSize: 10.5,
                          lineHeight: 1.6,
                          color: T.faint,
                          overflowWrap: 'anywhere', // a long file list wraps instead of escaping the card
                        }}
                      >
                        ✓ {ph.note}
                      </div>
                    )}
                  </div>
                );
              })}
              {phases.length === 0 &&
                ((snap?.body ?? '').trim() ? (
                  <div style={{ fontSize: 14, color: T.sub }}>
                    <Markdown text={snap?.body ?? ''} />
                  </div>
                ) : (
                  <div style={{ fontSize: 14, color: T.sub, lineHeight: 1.6 }}>
                    This plan has no phases yet. Ask in chat to fill it in, or write phases directly
                    in the body.
                  </div>
                ))}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 14.5, color: T.ink }}>
                <Markdown text={statement} />
              </div>
              {blocks.map((b) => (
                <div
                  key={b.heading}
                  style={{
                    marginTop: 18,
                    padding: '12px 15px',
                    border: `1.5px solid ${T.lineSoft}`,
                    borderRadius: 10,
                    background: T.card,
                  }}
                >
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: b.heading.toLowerCase().includes('drift') ? T.orange : T.faint,
                      letterSpacing: 1.2,
                      textTransform: 'uppercase',
                    }}
                  >
                    {b.heading}
                  </div>
                  <div style={{ fontSize: 13, color: T.ink, marginTop: 6 }}>
                    <Markdown text={b.content} />
                  </div>
                </div>
              ))}
            </>
          )}

          {anchors.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, letterSpacing: 1.2 }}>
                ANCHORS
              </div>
              {anchors.map((a, i) => (
                <div
                  key={`${a.file}:${a.symbol ?? i}`}
                  onClick={() => onOpenCode(a.file, a.span?.[0] ?? 1)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 12px',
                    borderRadius: 9,
                    border: `1.5px solid ${T.lineSoft}`,
                    background: T.card,
                    cursor: 'pointer',
                    marginTop: 7,
                  }}
                >
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.blue, flex: 1 }}>
                    {a.file}
                    {a.symbol ? ` · ${a.symbol}` : ' · (file)'}
                    {a.span ? ` :${a.span[0]}-${a.span[1]}` : ''}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.orange }}>
                    ⟨/⟩ open
                  </span>
                </div>
              ))}
            </div>
          )}

          {affects.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, letterSpacing: 1.2 }}>
                AFFECTS
              </div>
              {affects.map((id) => (
                <RelRow key={id} id={id} />
              ))}
            </div>
          )}
          {affectedBy.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, letterSpacing: 1.2 }}>
                AFFECTED BY
              </div>
              {affectedBy.map((id) => (
                <RelRow key={id} id={id} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A button that starts a scan pass. While one is running — this one or any other — it names what
 * is happening and refuses the click: main allows a single pass at a time, and before Phase 2.1 a
 * second press just queued another scanner over the same map with nothing on screen to say so.
 */
function ScanButton({
  scanning,
  busyLabel,
  onClick,
  title,
  children,
}: {
  scanning: boolean;
  busyLabel: string;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      onClick={scanning ? undefined : onClick}
      disabled={scanning}
      style={{
        ...btnGhost,
        padding: '6px 12px',
        cursor: scanning ? 'default' : 'pointer',
        opacity: scanning ? 0.6 : 1,
      }}
      title={scanning ? 'A scan is already running — wait for it to finish' : title}
    >
      {scanning ? busyLabel : children}
    </button>
  );
}
