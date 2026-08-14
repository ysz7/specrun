// The pyramid — the primary surface. Ported from the original design reference and
// wired to the real atlas view-model: an apex (project or a re-rooted domain), a context row of
// sibling chips, the focused branch with its children, SVG connectors, pan/zoom, and re-rooting.
import { useLayoutEffect, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { Card, Tick, Warn } from '../shared/ui';
import { visualFor, isShallow } from '../shared/status';
import {
  ancestorsOf,
  branchOf,
  childrenOf,
  driftCount,
  statementOf,
  type AtlasVm,
  type VmNode,
} from '../shared/viewmodel';

interface View {
  x: number;
  y: number;
  s: number;
}

interface PyramidProps {
  vm: AtlasVm;
  rootId: string | null;
  focusId: string | null;
  hotId: string | null;
  driftOnly: boolean;
  onFocus: (id: string) => void;
  onReRoot: (id: string) => void;
  onHome: () => void;
  onOpenNode: (id: string) => void;
  planMode: boolean; // plan mode (decision 54): notes have no rule counts — hide the "0 rules" badges
}

const isContainer = (n: VmNode): boolean => n.kind !== 'rule' && n.kind !== 'plan-step';
const clampScale = (s: number): number => Math.min(2.4, Math.max(0.3, s));

/**
 * The light Plan/Code marker (decision 55): one glyph that says whether a card is intent we plan to
 * build or behaviour the code already has — enough to tell the two branches apart at a glance,
 * without splitting the pyramid into two visual systems.
 */
function BranchMark({ node }: { node: VmNode }): React.JSX.Element | null {
  const branch = branchOf(node);
  if (!branch) return null;
  return (
    <span
      title={branch === 'plan' ? 'Plan — what we intend to build' : 'Code — what the code does'}
      style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, flex: '0 0 auto' }}
    >
      {branch === 'plan' ? '✎' : '⟨/⟩'}
    </span>
  );
}

function elbow(x1: number, y1: number, x2: number, y2: number, jy: number, r = 9): string {
  if (Math.abs(x2 - x1) < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dir = x2 > x1 ? 1 : -1;
  return `M ${x1} ${y1} L ${x1} ${jy - r} Q ${x1} ${jy} ${x1 + r * dir} ${jy} L ${x2 - r * dir} ${jy} Q ${x2} ${jy} ${x2} ${jy + r} L ${x2} ${y2}`;
}

interface Paths {
  comb: string[];
  dots: { x1: number; y1: number; x2: number; y2: number }[];
  h: number;
}

export function Pyramid({
  vm,
  rootId,
  focusId,
  hotId,
  driftOnly,
  onFocus,
  onReRoot,
  onHome,
  onOpenNode,
  planMode,
}: PyramidProps): React.JSX.Element {
  const apexId = rootId ?? vm.projectId;
  const apex = vm.byId.get(apexId)!;
  const children = childrenOf(vm, apexId);
  const focused = children.find((c) => c.id === focusId) ?? children[0];
  const branch = focused ? childrenOf(vm, focused.id) : [];

  const [view, setView] = useState<View>({ x: 0, y: 60, s: 1 });
  const [paths, setPaths] = useState<Paths | null>(null);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const treeRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // center on first mount
  useLayoutEffect(() => {
    const w = window.innerWidth;
    const s = Math.min(1, (w - 24) / 720);
    setView({ x: (w - 720 * s) / 2, y: 60, s });
  }, []);

  const reg = (id: string) => (el: HTMLElement | null) => {
    refs.current[id] = el;
  };

  // measure connector paths for the focused branch
  useLayoutEffect(() => {
    const measure = (): void => {
      const c = treeRef.current;
      if (!c) return setPaths(null);
      const cr = c.getBoundingClientRect();
      const sc = viewRef.current.s;
      const rel = (id: string): { x: number; y: number; w: number; h: number } | null => {
        const el = refs.current[id];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: (r.left - cr.left) / sc,
          y: (r.top - cr.top) / sc,
          w: r.width / sc,
          h: r.height / sc,
        };
      };
      const a = rel('apex');
      const f = focused ? rel(focused.id) : null;
      if (!a || !f) return setPaths(null);
      // Stop the connector well above the focused card (not 3px) so its arrowhead never collides
      // with / appears to sit inside the active card.
      const comb = [elbow(a.x + a.w / 2, a.y + a.h + 2, f.x + f.w / 2, f.y - 12, a.y + a.h + 26)];
      const dots: Paths['dots'] = [];
      let prev = f;
      for (const b of branch) {
        const rb = rel(b.id);
        if (!rb) continue;
        dots.push({
          x1: prev.x + prev.w / 2,
          y1: prev.y + prev.h + 3,
          x2: rb.x + rb.w / 2,
          y2: rb.y - 3,
        });
        prev = rb;
      }
      setPaths({ comb, dots, h: c.scrollHeight });
    };
    const t = setTimeout(measure, 60);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [apexId, focusId, branch.length, driftOnly]);

  // pan / zoom (mouse + wheel)
  const onMouseDown = (e: React.MouseEvent): void => {
    gesture.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMouseMove = (e: React.MouseEvent): void => {
    const g = gesture.current;
    if (!g) return;
    setView((v) => ({ ...v, x: g.vx + (e.clientX - g.x), y: g.vy + (e.clientY - g.y) }));
  };
  const endGesture = (): void => {
    gesture.current = null;
  };
  const onWheel = (e: React.WheelEvent): void => {
    const s = clampScale(view.s * (1 - e.deltaY * 0.0014));
    const k = s / view.s;
    setView({
      s,
      x: e.clientX - (e.clientX - view.x) * k,
      y: e.clientY - (e.clientY - view.y) * k,
    });
  };

  // A content node whose body is the point: a childless note (recipe/day), the plan roadmap
  // document, or a Plan/Code branch that is still empty (decisions 54/55). Clicking it opens its
  // body rather than re-rooting into an empty branch.
  const opensBody = (n: VmNode): boolean =>
    (n.kind === 'note' || n.kind === 'plan' || n.kind === 'section') &&
    childrenOf(vm, n.id).length === 0;

  const chipClick = (c: VmNode): void => {
    // A context chip only switches the focused branch; opening its content is the focused card's job.
    if (c.id === focused?.id) {
      if (rootId === null && childrenOf(vm, c.id).some(isContainer)) onReRoot(c.id);
    } else onFocus(c.id);
  };

  const focusedClick = (): void => {
    if (!focused) return;
    if (opensBody(focused)) {
      onOpenNode(focused.id); // open the body (works even when it's the apex)
      return;
    }
    if (rootId === null && childrenOf(vm, focused.id).some(isContainer)) onReRoot(focused.id);
  };
  const branchClick = (b: VmNode): void => {
    if (opensBody(b)) {
      onOpenNode(b.id);
      return;
    }
    if (isContainer(b)) {
      if (focused) onReRoot(focused.id);
      onFocus(b.id);
    } else onOpenNode(b.id);
  };

  const apexDrift = driftCount(apex);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        cursor: gesture.current ? 'grabbing' : 'grab',
        touchAction: 'none',
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endGesture}
      onMouseLeave={endGesture}
      onWheel={onWheel}
    >
      <div
        ref={treeRef}
        style={{
          position: 'absolute',
          transformOrigin: '0 0',
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
        }}
      >
        <Edges paths={paths} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: 720,
            position: 'relative',
            zIndex: 1,
            paddingTop: 68,
          }}
        >
          {/* Breadcrumbs (decision 56): the map is no longer two levels deep, so "↑ back to
              project" is not enough — every container on the way back is one click away. */}
          {rootId !== null && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 6,
                marginBottom: 14,
                fontFamily: T.mono,
                fontSize: 10.5,
                color: T.faint,
              }}
            >
              {ancestorsOf(vm, apexId).map((crumb, i) => (
                <span key={crumb.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {i > 0 && <span>›</span>}
                  <button
                    onClick={() => (crumb.id === vm.projectId ? onHome() : onReRoot(crumb.id))}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      fontFamily: T.mono,
                      fontSize: 10.5,
                      color: T.sub,
                    }}
                    title={`Back to ${crumb.title}`}
                  >
                    {crumb.title}
                  </button>
                </span>
              ))}
              <span>›</span>
              <span style={{ color: T.ink }}>{apex.title}</span>
            </div>
          )}

          {/* apex */}
          <Card
            cardRef={reg('apex')}
            onClick={() => rootId && onHome()}
            pad="14px 24px"
            dashed={apexDrift > 0 && rootId !== null}
            style={{ maxWidth: 440, textAlign: 'center' }}
          >
            <div style={{ fontFamily: T.serif, fontSize: 20, fontWeight: 600, color: T.ink }}>
              {apex.title}
            </div>
            <div style={{ width: 36, height: 2, background: T.orange, margin: '7px auto 0' }} />
            {/* The roof asserts (decision 56): a container's own statement is the point of the
                layer, so it is shown here rather than hidden inside a file nobody opens. */}
            {rootId && statementOf(vm, apexId) && (
              <div style={{ fontSize: 12.5, color: T.ink, marginTop: 8, lineHeight: 1.45 }}>
                {statementOf(vm, apexId)}
              </div>
            )}
            <div style={{ fontSize: 12, color: T.sub, marginTop: 7 }}>
              {rootId
                ? `${apex.path} · ${children.length} children · ${apex.rollup?.n ?? 0} rules`
                : vm.root}
            </div>
            {rootId && (
              <div style={{ fontSize: 11, color: T.orange, marginTop: 8, fontFamily: T.mono }}>
                ↑ back to project
              </div>
            )}
          </Card>

          {/* context chips */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              justifyContent: 'center',
              marginTop: 46,
              maxWidth: 680,
            }}
          >
            {children.map((c) => {
              const v = visualFor(c.rollup?.worst ?? c.status, c.flags);
              const isFocus = c.id === focused?.id;
              const dim = driftOnly && driftCount(c) === 0 && c.status !== 'drift';
              return (
                <Card
                  key={c.id}
                  onClick={() => chipClick(c)}
                  dashed={v.dashed}
                  hot={isFocus}
                  dim={dim}
                  pad="7px 12px"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    // opaque tint (not translucent orangeSoft) so the connector can't show through
                    background: isFocus ? T.orangeTint : T.card,
                  }}
                >
                  <BranchMark node={c} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: T.ink }}>{c.title}</span>
                  {!planMode && (
                    <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.faint }}>
                      {c.rollup?.n ?? 0}
                    </span>
                  )}
                  {!planMode && <Warn n={driftCount(c)} />}
                  {isShallow(c.flags) && (
                    <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint }}>shallow</span>
                  )}
                </Card>
              );
            })}
          </div>

          {/* focused branch */}
          {focused && (
            <>
              <Card
                cardRef={reg(focused.id)}
                onClick={focusedClick}
                dashed={driftCount(focused) > 0}
                hot
                pad="13px 18px"
                // Solid fill + above the connector SVG so the arrow never shows through the card.
                style={{ width: 320, marginTop: 40, background: T.card, zIndex: 2 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <BranchMark node={focused} />
                  <span style={{ fontSize: 15, fontWeight: 600, color: T.ink }}>
                    {focused.title}
                  </span>
                  {!planMode && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontFamily: T.mono,
                        fontSize: 10,
                        color: T.faint,
                      }}
                    >
                      {focused.rollup?.n ?? branch.length} rules
                    </span>
                  )}
                  {!planMode && <Warn n={driftCount(focused)} />}
                </div>
                {isContainer(focused) && statementOf(vm, focused.id) && (
                  <div style={{ fontSize: 12, color: T.sub, marginTop: 6, lineHeight: 1.45 }}>
                    {statementOf(vm, focused.id)}
                  </div>
                )}
                {opensBody(focused) ? (
                  <div style={{ fontSize: 11, color: T.orange, marginTop: 6, fontFamily: T.mono }}>
                    ↗ tap to open
                  </div>
                ) : (
                  rootId === null &&
                  childrenOf(vm, focused.id).some(isContainer) && (
                    <div
                      style={{ fontSize: 11, color: T.orange, marginTop: 6, fontFamily: T.mono }}
                    >
                      ⤓ tap to make it the apex
                    </div>
                  )
                )}
              </Card>

              {branch.map((b) => {
                const v = visualFor(b.status ?? b.rollup?.worst, b.flags);
                const leaf = !isContainer(b);
                return (
                  <Card
                    key={b.id}
                    cardRef={reg(b.id)}
                    onClick={() => branchClick(b)}
                    dashed={v.dashed}
                    hot={hotId === b.id}
                    dim={driftOnly && b.status !== 'drift' && driftCount(b) === 0}
                    pad="9px 13px"
                    style={{
                      width: 300,
                      marginTop: 20,
                      // pulse a step while it's being executed (decision 25 progress)
                      ...(b.status === 'in-progress'
                        ? { animation: 'alethicPulse 1.5s ease-in-out infinite' }
                        : {}),
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {leaf ? <Tick color={v.dot} /> : <BranchMark node={b} />}
                      <span
                        style={{ fontSize: 12.5, fontWeight: 550, color: T.ink, lineHeight: 1.3 }}
                      >
                        {b.title}
                      </span>
                      {!leaf && !planMode && (
                        <span
                          style={{
                            marginLeft: 'auto',
                            fontFamily: T.mono,
                            fontSize: 9.5,
                            color: T.faint,
                          }}
                        >
                          {b.rollup?.n ?? 0}
                        </span>
                      )}
                      {!leaf && !planMode && <Warn n={driftCount(b)} />}
                    </div>
                    {leaf && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 4, paddingLeft: 16 }}>
                        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.faint }}>
                          {b.path.replace(/^.*\//, '')}
                        </span>
                        {b.flags.includes('conflict') && (
                          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.orange }}>
                            ⚑ conflict
                          </span>
                        )}
                        {b.flags.includes('file-anchored') && (
                          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint }}>
                            file-anchored
                          </span>
                        )}
                        {/* How closely this feature has been read (decision 56): a deepened node
                            says so, so a bare card honestly reads as "not looked at closely yet". */}
                        {b.flags.includes('deepened') && (
                          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint }}>
                            ⤓ deepened
                          </span>
                        )}
                        {isShallow(b.flags) && (
                          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint }}>
                            shallow
                          </span>
                        )}
                        {/* Mapped before the unit became a feature (decision 56, Phase 6). Two
                            forms living in one map is the failure this marker exists to prevent:
                            unmarked, the reader just finds the map hard to read and never learns why. */}
                        {b.flags.includes('legacy-form') && (
                          <span
                            style={{ fontFamily: T.mono, fontSize: 9, color: T.orange }}
                            title="Old form: the assertion is the title and the body is one line. Open the branch above to migrate."
                          >
                            ⇪ old form
                          </span>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </>
          )}
          <div style={{ height: 160 }} />
        </div>
      </div>
    </div>
  );
}

function Edges({ paths }: { paths: Paths | null }): React.JSX.Element | null {
  if (!paths) return null;
  return (
    <svg
      width={720}
      height={paths.h}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 0,
        overflow: 'visible',
      }}
    >
      <defs>
        <marker id="arw" orient="auto" markerWidth="9" markerHeight="9" refX="6.5" refY="3.5">
          <path d="M0,0 L7,3.5 L0,7 z" fill={T.edge} />
        </marker>
      </defs>
      {paths.comb.map((d, i) => (
        <path
          key={`c${i}`}
          d={d}
          fill="none"
          stroke={T.edge}
          strokeWidth="1.5"
          markerEnd="url(#arw)"
        />
      ))}
      {paths.dots.map((l, i) => (
        <line
          key={`d${i}`}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke={T.orange}
          strokeWidth="2.2"
          strokeDasharray="0.1 6.5"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
