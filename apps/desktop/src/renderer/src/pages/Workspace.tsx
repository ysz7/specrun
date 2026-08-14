// Workspace — the main scene. Owns navigation state (apex/focus), the node expander, the code
// viewer, the Ctrl+K palette and the drift filter, all driven off the live atlas view-model.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { buildVm, childrenOf } from '../shared/viewmodel';
import { Pyramid } from '../widgets/Pyramid';
import { NodeExpander } from '../widgets/NodeExpander';
import { CodeViewer } from '../widgets/CodeViewer';
import { ChatPanel } from '../widgets/ChatPanel';
import { TerminalDrawer } from '../widgets/TerminalDrawer';
import { StatusBar } from '../widgets/StatusBar';
import { SystemBanner } from '../widgets/SystemBanner';
import { GitPanel } from '../features/GitPanel';
import { CommandPalette } from '../features/CommandPalette';
import { DiagnosticsPanel } from '../features/DiagnosticsPanel';
import { SettingsPanel } from '../features/SettingsPanel';
import type { AtlasSnapshot, PlanProgress, ScanProgress, SyncResult } from '../entities/node';

const MODEL = 'claude-sonnet-5';
// The passive notices (sync / phase / scan) float above the node card, which is a full-window
// overlay at 60 — and is exactly what Deepen and Rescan are launched from. Below it they render
// behind the card and auto-clear before it is closed, which reads as "the button does nothing".
const NOTICE_Z = 70;

interface WorkspaceProps {
  snapshot: AtlasSnapshot;
  onOpenFolder: () => void;
  onCloseProject: () => void;
  onSetMode: (mode: 'dev' | 'plan') => void;
  /** Bumped by the title bar's search button — a change opens the command palette. */
  openSearch?: number;
}

export function Workspace({
  snapshot,
  onOpenFolder,
  onCloseProject,
  onSetMode,
  openSearch,
}: WorkspaceProps): React.JSX.Element {
  const vm = useMemo(() => buildVm(snapshot), [snapshot]);
  const planMode = snapshot.mode === 'plan'; // dual-mode (decision 54): hide code affordances

  const [rootId, setRootId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hotId, setHotId] = useState<string | null>(null);
  const [code, setCode] = useState<{ file: string; line: number } | null>(null);
  const [planMsg, setPlanMsg] = useState<PlanProgress | null>(null);
  const [scanMsg, setScanMsg] = useState<ScanProgress | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The title bar's search button reaches the palette through a counter (0 = never pressed).
  useEffect(() => {
    if (openSearch) setPaletteOpen(true);
  }, [openSearch]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [driftOnly, setDriftOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<SyncResult | null>(null);
  const syncingRef = useRef(false);

  // Sync on demand and on window focus (Phase 7 task 1): coming back from the editor re-checks
  // the map against the code. Guarded so a focus storm can't stack passes.
  const runSync = useCallback(async (): Promise<void> => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await window.alethic.runSync(MODEL);
      if (result.ran) setBanner(result);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (planMode) return; // plan mode has no code to sync against
    const onFocus = (): void => void runSync();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [runSync, planMode]);

  // Auto-dismiss a quiet result (no drift, nothing to rescan) after a moment.
  useEffect(() => {
    if (!banner) return;
    if (banner.staleCount === 0 && banner.rescanDomains.length === 0) {
      const t = setTimeout(() => setBanner(null), 4000);
      return () => clearTimeout(t);
    }
    return;
  }, [banner]);

  // Phase-execution progress (mapping / done / blocked) — a passive line (decisions 15, 55).
  useEffect(() => {
    const off = window.alethic.onPlanProgress((p) => {
      setPlanMsg(p);
      if (p.phase === 'done') {
        const t = setTimeout(() => setPlanMsg((cur) => (cur === p ? null : cur)), 4000);
        return () => clearTimeout(t);
      }
      return;
    });
    return off;
  }, []);

  // Deepen / rescan / update-code-map run for minutes from a node card, and until Phase 2.1 their
  // progress was only rendered by the first-scan flow — outside it the button looked dead even
  // when the scan was working, and a failure was swallowed entirely.
  useEffect(() => {
    const off = window.alethic.onScanProgress((p) => {
      setScanMsg(p);
      if (p.phase === 'done' || p.phase === 'cancelled') {
        const t = setTimeout(() => setScanMsg((cur) => (cur === p ? null : cur)), 4000);
        return () => clearTimeout(t);
      }
      return;
    });
    return off;
  }, []);

  // default focus = first child of the apex, kept valid as the map changes live
  useEffect(() => {
    const apex = rootId ?? vm.projectId;
    const kids = childrenOf(vm, apex);
    if (!focusId || !kids.some((k) => k.id === focusId)) setFocusId(kids[0]?.id ?? null);
  }, [vm, rootId, focusId]);

  // Ctrl/Cmd+K opens the palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.key === 'Escape') {
        setExpandedId(null);
        setCode(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reRoot = (id: string): void => {
    setRootId(id);
    setFocusId(childrenOf(vm, id)[0]?.id ?? null);
  };
  const home = (): void => {
    setRootId(null);
    setFocusId(childrenOf(vm, vm.projectId)[0]?.id ?? null);
  };

  /** Teleport to a node: set apex/focus so it's visible, and open it if it's a leaf. */
  const reveal = (id: string): void => {
    const node = vm.byId.get(id);
    if (!node) return;
    setPaletteOpen(false);
    setHotId(id);
    if (node.kind === 'rule' || node.kind === 'plan-step') {
      const parent = node.parent ? vm.byId.get(node.parent) : undefined;
      setRootId(parent?.parent ?? null);
      setFocusId(node.parent ?? null);
      setExpandedId(id);
    } else if (node.kind === 'sub') {
      setRootId(node.parent ?? null);
      setFocusId(id);
    } else {
      setRootId(null);
      setFocusId(id);
    }
  };

  const apexId = rootId ?? vm.projectId;
  const apex = vm.byId.get(apexId);
  const totalRules = Object.values(vm.index.nodes).filter((n) => n.kind === 'rule').length;
  const totalDrift = Object.values(vm.index.rollup).reduce((s, r) => s + (r.drift ?? 0), 0);

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        background: T.bg,
        overflow: 'hidden',
        position: 'relative',
        fontFamily: T.sans,
      }}
    >
      {/* header */}
      <div
        style={{
          position: 'fixed',
          top: 10,
          left: 14,
          right: 14,
          zIndex: 10,
          pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}>
          <span
            onClick={home}
            style={{
              fontFamily: T.serif,
              fontSize: 14,
              fontWeight: 600,
              color: rootId ? T.sub : T.ink,
              cursor: 'pointer',
            }}
          >
            {vm.projectTitle}
          </span>
          {rootId && apex && (
            <>
              <span style={{ color: T.faint, fontSize: 11 }}>/</span>
              <span style={{ fontFamily: T.serif, fontSize: 14, fontWeight: 600, color: T.ink }}>
                {apex.title}
              </span>
            </>
          )}
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.faint, marginLeft: 6 }}>
            {planMode ? (
              'plan'
            ) : (
              <>
                {totalRules} rules · <span style={{ color: T.orange }}>⚠{totalDrift}</span>
              </>
            )}
          </span>
          <span
            onClick={() => onSetMode(planMode ? 'dev' : 'plan')}
            title="Switch between planning (notes) and software (code) mode"
            style={{
              marginLeft: 8,
              fontFamily: T.mono,
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              color: T.sub,
              background: T.card,
              border: `1.5px solid ${T.line}`,
            }}
          >
            {planMode ? '📝 plan' : '⚙ dev'}
          </span>
          {!planMode && (
            <span
              onClick={() => setDriftOnly((d) => !d)}
              style={{
                marginLeft: 8,
                fontFamily: T.mono,
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 8,
                cursor: 'pointer',
                color: driftOnly ? '#fff' : T.sub,
                background: driftOnly ? T.orange : T.card,
                border: `1.5px solid ${driftOnly ? T.orange : T.line}`,
              }}
            >
              ⚠ drift
            </span>
          )}
          {!planMode && (
            <span
              onClick={() => void runSync()}
              title="Check the map against the code (runs on window focus too)"
              style={{
                marginLeft: 6,
                fontFamily: T.mono,
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 8,
                cursor: syncing ? 'default' : 'pointer',
                color: T.sub,
                background: T.card,
                border: `1.5px solid ${T.line}`,
                opacity: syncing ? 0.6 : 1,
              }}
            >
              {syncing ? '⟳ syncing…' : '⟳ sync'}
            </span>
          )}
          <span
            onClick={onOpenFolder}
            title="Open another project folder (Ctrl+O). An empty folder starts a new build."
            style={{
              marginLeft: 'auto',
              fontFamily: T.mono,
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              color: T.sub,
              background: T.card,
              border: `1.5px solid ${T.line}`,
            }}
          >
            ⌂ Open folder…
          </span>
          <span
            onClick={onCloseProject}
            title="Close this project and return to the start screen"
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              color: T.sub,
              background: T.card,
              border: `1.5px solid ${T.line}`,
            }}
          >
            ✕ Close
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.faint }}>Ctrl+K to search</span>
        </div>
      </div>

      {banner && (
        <div
          style={{
            position: 'fixed',
            top: 44,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: NOTICE_Z,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 14px',
            borderRadius: 10,
            background: T.card,
            border: `1.5px solid ${banner.rescanDomains.length ? T.orange : T.line}`,
            fontFamily: T.mono,
            fontSize: 11.5,
            color: T.ink,
            boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
            maxWidth: '80vw',
            flexWrap: 'wrap',
          }}
        >
          <span>
            Synced ({banner.method}) · {banner.changedFiles} file
            {banner.changedFiles === 1 ? '' : 's'} · {banner.staleCount} newly stale
            {banner.annotationsChanged ? ` · ${banner.annotationsChanged} annotated` : ''}
          </span>
          {/* A feature stands for many symbols (decision 56), so the count alone says nothing about
              what to look at. The deterministic check already knows which part of which feature
              moved — it is shown before the judge has said a word (format-spec §5.3). */}
          {banner.staleAt.length > 0 && (
            <span
              style={{
                flexBasis: '100%',
                color: T.sub,
                fontSize: 10.5,
                lineHeight: 1.6,
                overflowWrap: 'anywhere',
              }}
            >
              {banner.staleAt.slice(0, 4).map((line) => (
                <div key={line}>{line}</div>
              ))}
              {banner.staleAt.length > 4 && <div>…and {banner.staleAt.length - 4} more</div>}
            </span>
          )}
          {banner.rescanDomains.length > 0 && (
            <span style={{ color: T.orange }}>
              rescan recommended:{' '}
              {banner.rescanDomains.map((slug) => (
                <button
                  key={slug}
                  onClick={() => void window.alethic.rescanDomain(slug, MODEL)}
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    marginLeft: 4,
                    padding: '2px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: '#fff',
                    background: T.orange,
                    border: 'none',
                  }}
                >
                  {slug}
                </button>
              ))}
            </span>
          )}
          <span
            onClick={() => setBanner(null)}
            style={{ cursor: 'pointer', color: T.faint, marginLeft: 4 }}
          >
            ✕
          </span>
        </div>
      )}

      {planMsg && planMsg.phase !== 'executing' && (
        <div
          style={{
            position: 'fixed',
            top: banner ? 84 : 44,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: NOTICE_Z,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderRadius: 10,
            background: T.card,
            border: `1.5px solid ${planMsg.phase === 'blocked' ? T.orange : T.line}`,
            fontFamily: T.mono,
            fontSize: 11.5,
            color: T.ink,
            boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
          }}
        >
          <span>
            {planMsg.phase === 'mapping' && `${planMsg.phaseTitle} — mapping the new code…`}
            {planMsg.phase === 'done' && `✓ ${planMsg.phaseTitle} — done`}
            {planMsg.phase === 'blocked' &&
              `⚑ ${planMsg.phaseTitle} blocked: ${planMsg.message ?? ''}`}
            {planMsg.phase === 'error' && `⚠ ${planMsg.message ?? 'execution error'}`}
          </span>
          <span
            onClick={() => setPlanMsg(null)}
            style={{ cursor: 'pointer', color: T.faint, marginLeft: 4 }}
          >
            ✕
          </span>
        </div>
      )}

      {scanMsg && scanMsg.phase !== 'repo-map' && scanMsg.phase !== 'decompose' && (
        <div
          style={{
            position: 'fixed',
            top: 44 + (banner ? 40 : 0) + (planMsg && planMsg.phase !== 'executing' ? 40 : 0),
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: NOTICE_Z,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderRadius: 10,
            background: T.card,
            border: `1.5px solid ${scanMsg.phase === 'error' ? T.orange : T.line}`,
            fontFamily: T.mono,
            fontSize: 11.5,
            color: T.ink,
            boxShadow: '0 6px 20px rgba(0,0,0,0.08)',
          }}
        >
          <span>
            {scanMsg.phase === 'scanning' &&
              `⤓ ${scanMsg.message ?? 'reading the code'}${scanMsg.domain ? ` · ${scanMsg.domain}` : ''}${
                scanMsg.total > 1 ? ` · ${scanMsg.completed}/${scanMsg.total}` : ''
              }…`}
            {scanMsg.phase === 'done' && '✓ the map is up to date'}
            {scanMsg.phase === 'cancelled' && 'scan cancelled'}
            {scanMsg.phase === 'error' && `⚠ ${scanMsg.message ?? 'scan error'}`}
          </span>
          <span
            onClick={() => setScanMsg(null)}
            style={{ cursor: 'pointer', color: T.faint, marginLeft: 4 }}
          >
            ✕
          </span>
        </div>
      )}

      <SystemBanner projectRoot={snapshot.root} />

      <Pyramid
        vm={vm}
        rootId={rootId}
        focusId={focusId}
        hotId={hotId}
        driftOnly={driftOnly}
        onFocus={setFocusId}
        onReRoot={reRoot}
        onHome={home}
        onOpenNode={setExpandedId}
        planMode={planMode}
      />

      {expandedId && (
        <NodeExpander
          vm={vm}
          nodeId={expandedId}
          onClose={() => setExpandedId(null)}
          onOpenCode={(file, line) => setCode({ file, line })}
          onNavigate={(id) => setExpandedId(id)}
        />
      )}
      {code && <CodeViewer file={code.file} line={code.line} onClose={() => setCode(null)} />}
      {paletteOpen && (
        <CommandPalette vm={vm} onPick={reveal} onClose={() => setPaletteOpen(false)} />
      )}
      <ChatPanel
        vm={vm}
        view={{ apexId, focusId, expandedId }}
        onReveal={reveal}
        mode={snapshot.mode}
      />

      {gitOpen && <GitPanel onClose={() => setGitOpen(false)} />}
      {terminalOpen && <TerminalDrawer onClose={() => setTerminalOpen(false)} />}
      {diagnosticsOpen && <DiagnosticsPanel onClose={() => setDiagnosticsOpen(false)} />}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        />
      )}
      <StatusBar
        gitOpen={gitOpen}
        terminalOpen={terminalOpen}
        onToggleGit={() => setGitOpen((v) => !v)}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </div>
  );
}
