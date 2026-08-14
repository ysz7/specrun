// ChatPanel — the right dock (like the assistant in Cursor / Claude Code in an IDE): streamed
// answers, a model selector, permission cards, per-project history, and /clear. Talks only to
// window.alethic; the agent, auth and history all live in main. In Phase 8 it is the Navigator's
// surface: it ships a light view context (decision 20), links cited node ids to the pyramid
// (decision 21) and turns a [[PLAN]] proposal into a Create-plan affordance (creation is Phase 9).
import { Fragment, useEffect, useRef, useState } from 'react';
import { T } from '../shared/tokens';
import { btnGhost, btnPrimary } from '../shared/ui';
import {
  buildNavigatorContext,
  citedNodeIds,
  detectPlanProposal,
  segmentMessage,
  type NavigatorView,
} from '../shared/navigator';
import { useScanActivity } from '../shared/useScanActivity';
import type { AtlasVm } from '../shared/viewmodel';
import type {
  AttachedFile,
  ChatMessage,
  ChatStep,
  ModelOption,
  PermissionRequest,
} from '../entities/node';

const MIN_W = 320;
const MAX_W = 760;
const DEFAULT_W = 460; // wider default than before; persisted per user after a resize
const WIDTH_KEY = 'alethic.chatWidth';
const CONTEXT_BUDGET = 190_000; // rough usable context window; drives the composer's context gauge

/** Rough token estimate (~4 chars/token) of the whole chat, for the context gauge. */
function estimateChatTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.text.length;
    for (const s of m.steps ?? []) chars += s.kind === 'text' ? s.text.length : s.name.length + 8;
  }
  return Math.ceil(chars / 4);
}

// The live turn is a chain of steps (like the Claude Code / VS Code transcript): streamed text
// blocks interleaved with tool calls, each tool carrying its own running/done/error status.
interface ToolStep {
  kind: 'tool';
  id: number;
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
}
interface TextStep {
  kind: 'text';
  text: string;
}
type Step = ToolStep | TextStep;
interface Turn {
  taskId: string;
  steps: Step[];
}

let toolIdSeq = 0; // module-level so each tool step gets a stable React key

function appendText(turn: Turn | null, taskId: string, text: string): Turn {
  const base = turn ?? { taskId, steps: [] };
  const steps = [...base.steps];
  const last = steps[steps.length - 1];
  if (last && last.kind === 'text') steps[steps.length - 1] = { ...last, text: last.text + text };
  else steps.push({ kind: 'text', text });
  return { ...base, steps };
}
function addTool(turn: Turn | null, taskId: string, name: string, input: unknown): Turn {
  const base = turn ?? { taskId, steps: [] };
  return {
    ...base,
    steps: [...base.steps, { kind: 'tool', id: ++toolIdSeq, name, input, status: 'running' }],
  };
}
function finishTool(turn: Turn | null, isError: boolean | undefined): Turn | null {
  if (!turn) return turn;
  const steps = [...turn.steps];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === 'tool' && s.status === 'running') {
      steps[i] = { ...s, status: isError ? 'error' : 'done' };
      break;
    }
  }
  return { ...turn, steps };
}

interface ChatPanelProps {
  vm: AtlasVm;
  view: NavigatorView;
  onReveal: (id: string) => void;
  mode: 'dev' | 'plan';
}

export function ChatPanel({ vm, view, onReveal, mode }: ChatPanelProps): React.JSX.Element {
  // Keep the latest vm/reveal reachable from the (mount-time) event subscription.
  const vmRef = useRef(vm);
  vmRef.current = vm;
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('claude-sonnet-5');
  const [connected, setConnected] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [input, setInput] = useState('');
  const [turn, setTurn] = useState<Turn | null>(null); // the live chain of steps for the running task
  const [work, setWork] = useState<{ tokens: number } | null>(null); // agent is running → show a pill
  const [permits, setPermits] = useState<PermissionRequest[]>([]);
  // A scan pass rewrites the map from the code; a task typed on top of it would answer from a map
  // that is mid-change. The composer says so and waits instead (Phase 2.1, from dog-fooding).
  const scan = useScanActivity();
  const [attached, setAttached] = useState<AttachedFile[]>([]); // files staged for the next message
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    const wanted = saved >= MIN_W && saved <= MAX_W ? saved : DEFAULT_W;
    // The app opens as a compact window, where a 460px dock would outweigh the map it is there to
    // discuss. Cap the opening width at half the window; the stored preference is left untouched,
    // so a wider window (or a drag) brings it straight back.
    return Math.max(MIN_W, Math.min(wanted, Math.round(window.innerWidth * 0.5)));
  });
  const currentTask = useRef<string | null>(null);
  const liveText = useRef(''); // the reply text alone — what gets persisted as the message
  const endRef = useRef<HTMLDivElement>(null);

  // Drag the left border to resize; the panel is right-anchored so width = viewport − cursor x.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const next = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      setWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const attach = (): void => {
    void window.alethic.pickFiles().then((files) => {
      if (files.length) setAttached((prev) => [...prev, ...files]);
    });
  };

  const stop = (): void => {
    if (currentTask.current) void window.alethic.cancelTask(currentTask.current);
  };

  const compact = (): void => {
    void window.alethic.compactChat().then(setMessages);
  };

  const ctxTokens = estimateChatTokens(messages);
  const ctxFraction = Math.min(1, ctxTokens / CONTEXT_BUDGET);

  useEffect(() => {
    void window.alethic.chatHistory().then(setMessages);
    void window.alethic.listModels().then((m) => {
      setModels(m);
      if (m[0]) setModel((prev) => (m.some((x) => x.id === prev) ? prev : m[0]!.id));
    });
    void window.alethic.authStatus().then((s) => setConnected(s.connected));
    // A task may already be running when the panel mounts (e.g. the greenfield build started while
    // the Start screen was still up). Show the working state immediately instead of waiting for the
    // first token.
    void window.alethic.activeTask().then(({ taskId }) => {
      if (taskId && currentTask.current === null) {
        currentTask.current = taskId;
        liveText.current = '';
        setWork({ tokens: 0 });
      }
    });

    const offEvent = window.alethic.onAgentEvent((e) => {
      // Adopt a background agent run the chat didn't start itself — the greenfield "Start
      // building" task, a step execution — so its progress is visible here instead of silent.
      // `started` fires before the first token, so the working pill appears immediately.
      if (
        currentTask.current === null &&
        (e.type === 'started' || e.type === 'text' || e.type === 'tool')
      ) {
        currentTask.current = e.taskId;
        liveText.current = '';
        setTurn({ taskId: e.taskId, steps: [] });
        setWork({ tokens: 0 });
      }
      if (e.taskId !== currentTask.current) return;
      if (e.type === 'text') {
        liveText.current += e.text;
        setConnected(true); // a streamed answer proves Claude is connected (decision 38)
        setTurn((t) => appendText(t, e.taskId, e.text));
      } else if (e.type === 'tool') {
        setTurn((t) => addTool(t, e.taskId, e.name, e.input));
      } else if (e.type === 'tool-result') {
        setTurn((t) => finishTool(t, e.isError));
      } else if (e.type === 'usage') {
        // Show only the current step's output tokens (live), not a growing conversation total.
        setWork({ tokens: e.outputTokens });
      } else if (e.type === 'done' || e.type === 'error') {
        if (e.type === 'done') setConnected(true);
        const text = (liveText.current || (e.type === 'error' ? `⚠ ${e.message}` : '')).trim();
        // Main has just persisted the whole turn (text + tool chain); pull the authoritative history
        // so the finished chain stays in view instead of collapsing to the final text.
        void window.alethic.chatHistory().then(setMessages);
        // Teleport to the first node the answer cited (decision 21).
        const ids = citedNodeIds(text, vmRef.current);
        if (ids[0]) revealRef.current(ids[0]);
        liveText.current = '';
        setTurn(null);
        setWork(null);
        currentTask.current = null;
      }
    });
    const offPermit = window.alethic.onPermission((r) => {
      // A question/permission means this task is active — adopt it so the working pill shows.
      if (currentTask.current === null) {
        currentTask.current = r.taskId;
        setWork((w) => w ?? { tokens: 0 });
      }
      setPermits((p) => [...p, r]);
    });
    return () => {
      offEvent();
      offPermit();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, turn, work, permits]);

  const send = (): void => {
    const prompt = input.trim();
    if (!prompt || scan.running) return;
    if (prompt === '/clear') {
      void window.alethic.clearChat().then(() => setMessages([]));
      setInput('');
      setAttached([]);
      return;
    }
    // Show attached filenames alongside the message so history reflects what was sent.
    const shown = attached.length
      ? `${prompt}\n\n📎 ${attached.map((a) => a.name).join(', ')}`
      : prompt;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', text: shown, ts: new Date().toISOString() },
    ]);
    setInput('');
    // dev → Navigator (read-only, routes tasks to plans); plan → Plan Author (writes note content
    // directly, decision 54). Both get the light view context (decision 20) + any attachments.
    const role = mode === 'plan' ? 'plan-author' : 'navigator';
    const base = buildNavigatorContext(vmRef.current, viewRef.current);
    const filesBlock = attached.length
      ? `\n\n[ATTACHED FILES]\n${attached
          .map((a) => `--- ${a.name} (${a.path}) ---\n${a.text}`)
          .join('\n\n')}`
      : '';
    const context = base + filesBlock;
    setAttached([]);
    setWork({ tokens: 0 });
    void window.alethic.sendMessage(prompt, model, role, context).then(({ taskId }) => {
      currentTask.current = taskId;
      liveText.current = '';
      setTurn({ taskId, steps: [] });
    });
  };

  // Decision 1 — the three Claude Code answers: Yes / Yes, don't ask again this session / No.
  const respond = (req: PermissionRequest, allow: boolean, remember = false): void => {
    void window.alethic.respondPermission(req.requestId, allow, undefined, remember);
    setPermits((p) => p.filter((x) => x.requestId !== req.requestId));
  };

  // AskUserQuestion has no headless runtime in the SDK; hand the user's choice back as the tool
  // result (the deny-message channel) so the agent reads the answer and continues.
  const answerQuestion = (req: PermissionRequest, message: string): void => {
    void window.alethic.respondPermission(req.requestId, false, message);
    setPermits((p) => p.filter((x) => x.requestId !== req.requestId));
  };

  const connectClaudeCode = (): void => {
    void window.alethic.loginClaudeCode();
    let waited = 0;
    const t = setInterval(() => {
      waited += 2;
      void window.alethic.authStatus().then((s) => {
        if (s.connected) {
          setConnected(true);
          clearInterval(t);
        }
      });
      if (waited >= 180) clearInterval(t);
    }, 2000);
  };

  const connect = (): void => {
    void window.alethic.setApiKey(apiKey.trim()).then((s) => {
      setConnected(s.connected);
      setApiKey('');
    });
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 26, // clear the status bar so the input row isn't hidden behind it
        width,
        zIndex: 30,
        background: T.paper,
        borderLeft: `1.5px solid ${T.line}`,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: T.sans,
      }}
    >
      {/* Drag the left border to resize the panel. */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{
          position: 'absolute',
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'ew-resize',
          zIndex: 31,
        }}
      />

      {!connected && (
        <div
          style={{
            padding: '10px 12px',
            background: T.orangeSoft,
            borderBottom: `1.5px solid rgba(217,98,43,0.3)`,
          }}
        >
          <div style={{ fontSize: 12, color: T.ink, marginBottom: 8, lineHeight: 1.5 }}>
            Connect Claude to run the agent. The map works without it.
          </div>
          <button
            onClick={connectClaudeCode}
            style={{ ...btnPrimary, width: '100%', padding: '9px 12px', marginBottom: 8 }}
            title="Opens your browser to sign in with your Claude subscription"
          >
            🌐 Connect with Claude Code
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
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
            <button onClick={connect} style={{ ...btnPrimary, padding: '6px 12px' }}>
              Connect
            </button>
          </div>
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            overflowY: 'auto',
            // The transcript reads top-to-bottom and never sideways: with only overflow-y set, the
            // other axis computes to `auto`, so one wide line (a long path, a tool argument) would
            // scroll the whole conversation off-screen. Wide content wraps or clips inside its own
            // block instead.
            overflowX: 'hidden',
            padding: '12px',
            paddingBottom: 96, // clear the floating composer so the last message can scroll above it
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {messages.length === 0 && !turn && !work && permits.length === 0 && (
            <div style={{ color: T.sub, fontSize: 12.5, padding: '20px 4px', lineHeight: 1.6 }}>
              {mode === 'plan'
                ? 'Nothing here yet. Describe what you want — a trip, a decision, a piece of writing — and the plan starts from your answer.'
                : 'Nothing here yet. Ask about the project or describe what you want built — the map is read before anything is written.'}
            </div>
          )}
          {messages.map((m) =>
            m.role === 'assistant' && m.steps && m.steps.length ? (
              <ChainView
                key={m.id}
                steps={m.steps.map((s, i) => ({ ...s, key: `${m.id}-${i}` }))}
                vm={vm}
                onReveal={onReveal}
                model={model}
              />
            ) : (
              <Bubble
                key={m.id}
                role={m.role}
                text={m.text}
                vm={vm}
                onReveal={onReveal}
                model={model}
              />
            ),
          )}
          {turn && (
            <ChainView
              steps={turn.steps.map((s, i) => ({
                ...s,
                key: s.kind === 'tool' ? `k${s.id}` : `t${i}`,
              }))}
              vm={vm}
              onReveal={onReveal}
              model={model}
            />
          )}
          {work && permits.length === 0 && <WorkingPill tokens={work.tokens} />}
          {scan.running && <ScanPill domain={scan.domain} />}
          {permits.map((req) =>
            req.toolName === 'AskUserQuestion' ? (
              <QuestionCard
                key={req.requestId}
                input={req.input}
                onAnswer={(msg) => answerQuestion(req, msg)}
              />
            ) : (
              <div
                key={req.requestId}
                style={{
                  border: `1.5px solid ${T.orange}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                  background: T.card,
                }}
              >
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.orange }}>
                  permission · {req.toolName}
                </div>
                <pre
                  style={{
                    fontFamily: T.mono,
                    fontSize: 10.5,
                    color: T.sub,
                    whiteSpace: 'pre-wrap',
                    margin: '6px 0',
                  }}
                >
                  {JSON.stringify(req.input, null, 2).slice(0, 400)}
                </pre>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => respond(req, true)}
                    style={{ ...btnPrimary, padding: '6px 12px' }}
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => respond(req, true, true)}
                    style={{ ...btnGhost, padding: '6px 12px' }}
                    title={`Allow ${req.toolName} for the rest of this session without asking`}
                  >
                    Allow this session
                  </button>
                  <button
                    onClick={() => respond(req, false)}
                    style={{ ...btnGhost, padding: '6px 12px' }}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>

        {/* Composer floats over the messages so text scrolls up to the input; the surround is
          transparent (only the rounded box is opaque) and click-through to the messages behind. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '10px 12px',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 8,
              borderRadius: 16,
              border: `1.5px solid ${T.line}`,
              background: T.card,
              pointerEvents: 'auto',
              boxShadow: '0 2px 16px rgba(35,34,30,0.10)',
            }}
          >
            {attached.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 4px 0' }}>
                {attached.map((f, i) => (
                  <span
                    key={`${f.path}-${i}`}
                    title={f.path}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontFamily: T.mono,
                      fontSize: 11,
                      padding: '3px 6px 3px 8px',
                      borderRadius: 7,
                      background: T.bg,
                      border: `1px solid ${T.lineSoft}`,
                      color: T.ink,
                    }}
                  >
                    📎 {f.name}
                    <span
                      onClick={() => setAttached((prev) => prev.filter((_, idx) => idx !== i))}
                      style={{ cursor: 'pointer', color: T.faint }}
                    >
                      ✕
                    </span>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder='Ask the project…  ("/clear" to reset)'
              rows={1}
              style={{
                resize: 'none',
                minHeight: 24,
                maxHeight: 160,
                fontSize: 14,
                fontFamily: T.sans,
                lineHeight: 1.5,
                padding: '4px 6px',
                border: 'none',
                background: 'transparent',
                color: T.ink,
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={attach}
                title="Attach files"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 99,
                  border: `1.5px solid ${T.line}`,
                  background: T.paper,
                  color: T.sub,
                  cursor: 'pointer',
                  fontSize: 17,
                  lineHeight: 1,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                +
              </button>
              <ContextGauge fraction={ctxFraction} tokens={ctxTokens} onClick={compact} />
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                title="Model"
                style={{
                  marginLeft: 'auto',
                  fontFamily: T.mono,
                  fontSize: 11.5,
                  padding: '4px 6px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: T.sub,
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              {work ? (
                <button
                  onClick={stop}
                  title="Stop the agent"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 99,
                    border: 'none',
                    background: T.orange,
                    color: '#fff',
                    cursor: 'pointer',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: '#fff' }} />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!input.trim() || scan.running}
                  title={
                    scan.running
                      ? 'The map is being read from the code — wait for the scan to finish'
                      : 'Send'
                  }
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 99,
                    border: 'none',
                    background: T.orange,
                    color: '#fff',
                    cursor: input.trim() && !scan.running ? 'pointer' : 'default',
                    opacity: input.trim() && !scan.running ? 1 : 0.5,
                    fontSize: 15,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The scan's own working line: not this chat's task, but it owns the map until it finishes. */
function ScanPill({ domain }: { domain?: string | undefined }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        padding: '2px 2px',
        fontSize: 12,
        color: T.sub,
        fontFamily: T.sans,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 99,
          background: T.blue,
          animation: 'alethicBlink 1.2s ease-in-out infinite',
        }}
      />
      <span style={{ animation: 'alethicBlink 1.2s ease-in-out infinite' }}>
        Reading the code into the map{domain ? ` · ${domain}` : ''}…
      </span>
    </div>
  );
}

/** Compact "1.6k" style token count for the working pill. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A small ring showing how full the chat context is; click to compact (free context). */
function ContextGauge({
  fraction,
  tokens,
  onClick,
}: {
  fraction: number;
  tokens: number;
  onClick: () => void;
}): React.JSX.Element {
  const r = 8;
  const circ = 2 * Math.PI * r;
  const color = fraction > 0.85 ? '#B3452B' : fraction > 0.6 ? T.orange : T.sub;
  return (
    <button
      onClick={onClick}
      title={`Context ~${Math.round(fraction * 100)}% (~${formatTokens(tokens)} tokens) · click to compact`}
      style={{
        width: 30,
        height: 30,
        borderRadius: 99,
        border: `1.5px solid ${T.line}`,
        background: T.paper,
        cursor: 'pointer',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
      }}
    >
      <svg width={18} height={18} viewBox="0 0 24 24" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={12} cy={12} r={r} fill="none" stroke={T.lineSoft} strokeWidth={3.5} />
        <circle
          cx={12}
          cy={12}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3.5}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - fraction)}
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/** The animated "the agent is working" line, with a live token count (like Claude Code). */
function WorkingPill({ tokens }: { tokens: number }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        padding: '2px 2px',
        fontSize: 12,
        color: T.sub,
        fontFamily: T.sans,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 99,
          background: T.orange,
          animation: 'alethicBlink 1.2s ease-in-out infinite',
        }}
      />
      <span style={{ animation: 'alethicBlink 1.2s ease-in-out infinite' }}>Working…</span>
      {tokens > 0 && <span style={{ color: T.faint }}>· {formatTokens(tokens)} tokens</span>}
    </div>
  );
}

/** Turn a tool call into a short, human label + detail (like the VS Code / Claude Code step list). */
function describeTool(
  name: string,
  input: unknown,
): { label: string; detail?: string | undefined } {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof inp[k] === 'string' ? (inp[k] as string) : undefined;
  const base = (p: string | undefined): string | undefined =>
    p ? (p.split(/[\\/]/).pop() ?? p) : undefined;
  const clip = (s: string | undefined, n = 60): string | undefined =>
    s && s.length > n ? `${s.slice(0, n)}…` : s;

  switch (name) {
    case 'Read':
      return { label: 'Read', detail: base(str('file_path')) };
    case 'Edit':
      return { label: 'Edit', detail: base(str('file_path')) };
    case 'Write':
      return { label: 'Write', detail: base(str('file_path')) };
    case 'Grep':
      return { label: 'Grep', detail: clip(str('pattern')) };
    case 'Glob':
      return { label: 'Glob', detail: clip(str('pattern')) };
    case 'Bash':
    case 'PowerShell':
      return { label: name, detail: clip(str('command'), 72) };
    case 'ToolSearch':
      return { label: 'Search tools', detail: clip(str('query')) };
    case 'AskUserQuestion':
      return { label: 'Asked a question' };
    case 'WebFetch':
      return { label: 'Fetch', detail: clip(str('url')) };
    case 'WebSearch':
      return { label: 'Web search', detail: clip(str('query')) };
    case 'TodoWrite':
      return { label: 'Update plan' };
  }
  // MCP tools arrive as mcp__<server>__<tool>; show them as "alethic · set thesis".
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = parts[1] ?? 'mcp';
    const tool = parts
      .slice(2)
      .join('__')
      .replace(/^alethic_/, '')
      .replace(/_/g, ' ');
    return { label: server, detail: tool };
  }
  return { label: name };
}

/** One step row: a rail with a status dot (connected by a vertical line to the adjacent tool steps,
 * VS Code style) + a tool label. Shared by the live turn and persisted history. */
function StepRow({
  name,
  input,
  status,
  connectUp,
  connectDown,
}: {
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
  connectUp: boolean;
  connectDown: boolean;
}): React.JSX.Element {
  const { label, detail } = describeTool(name, input);
  const color = status === 'error' ? '#B3452B' : status === 'done' ? T.green : T.orange;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 9, minHeight: 24 }}>
      <div style={{ position: 'relative', width: 14, flex: '0 0 auto' }}>
        {connectUp && (
          <span
            style={{
              position: 'absolute',
              left: 6,
              top: 0,
              height: '50%',
              width: 2,
              background: T.lineSoft,
            }}
          />
        )}
        {connectDown && (
          <span
            style={{
              position: 'absolute',
              left: 6,
              bottom: 0,
              height: '50%',
              width: 2,
              background: T.lineSoft,
            }}
          />
        )}
        <span
          style={{
            position: 'absolute',
            left: 3.5,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 7,
            height: 7,
            borderRadius: 99,
            background: color,
            animation: status === 'running' ? 'alethicBlink 1.2s ease-in-out infinite' : 'none',
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          minWidth: 0,
          fontSize: 12.5,
          fontFamily: T.sans,
          color: T.ink,
        }}
      >
        <span style={{ fontWeight: 550, flex: '0 0 auto' }}>{label}</span>
        {detail && (
          <span
            style={{
              color: T.faint,
              fontFamily: T.mono,
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

/** An assistant turn's tool/text chain (live or persisted). Consecutive tool steps are joined by a
 * connector line; text steps render as plain (borderless) message blocks. */
function ChainView({
  steps,
  vm,
  onReveal,
  model,
}: {
  steps: ((ChatStep | Step) & { key: string })[];
  vm: AtlasVm;
  onReveal: (id: string) => void;
  model: string;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignSelf: 'stretch', minWidth: 0 }}>
      {steps.map((s, i) => {
        if (s.kind === 'text')
          return s.text.trim() ? (
            <div key={s.key} style={{ padding: '5px 0' }}>
              <Bubble role="assistant" text={s.text} vm={vm} onReveal={onReveal} model={model} />
            </div>
          ) : null;
        return (
          <StepRow
            key={s.key}
            name={s.name}
            input={s.input}
            status={s.status}
            connectUp={steps[i - 1]?.kind === 'tool'}
            connectDown={steps[i + 1]?.kind === 'tool'}
          />
        );
      })}
    </div>
  );
}

interface QOption {
  label: string;
  description?: string;
  preview?: string;
}
interface QItem {
  question: string;
  header?: string;
  options: QOption[];
  multiSelect?: boolean;
}

/** Read the AskUserQuestion tool input into a typed list, tolerant of a malformed payload. */
function parseQuestions(input: unknown): QItem[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is QItem => !!q && typeof q === 'object' && Array.isArray((q as QItem).options),
  );
}

/**
 * Render an AskUserQuestion tool call as a real choice UI (like the VS Code / Claude Code question
 * card) instead of raw JSON. Single-select picks one option; multiSelect toggles many; an "Other"
 * field is always available (the tool provides it implicitly). The answer is handed back to the
 * agent to continue with.
 */
function QuestionCard({
  input,
  onAnswer,
}: {
  input: unknown;
  onAnswer: (message: string) => void;
}): React.JSX.Element {
  const [questions] = useState(() => parseQuestions(input));
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean): void =>
    setPicks((prev) => {
      const cur = prev[qi] ?? [];
      if (!multi) return { ...prev, [qi]: [label] };
      return {
        ...prev,
        [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });

  const answerFor = (qi: number): string[] => {
    const chosen = [...(picks[qi] ?? [])];
    const o = other[qi]?.trim();
    if (o) chosen.push(o);
    return chosen;
  };
  const allAnswered = questions.length > 0 && questions.every((_, qi) => answerFor(qi).length > 0);

  const submit = (): void => {
    if (!allAnswered) return;
    setSent(true);
    const lines = questions.map(
      (q) => `${q.question}\n→ ${answerFor(questions.indexOf(q)).join(', ')}`,
    );
    onAnswer(
      `The user answered your question${questions.length > 1 ? 's' : ''}:\n\n${lines.join('\n\n')}`,
    );
  };

  if (questions.length === 0) {
    // Fall back to a plain acknowledgement if the payload wasn't shaped as expected.
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 13, color: T.ink, marginBottom: 8 }}>
          The agent asked a question.
        </div>
        <button
          onClick={() => onAnswer('Please continue.')}
          style={{ ...btnPrimary, padding: '6px 12px' }}
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      {questions.map((q, qi) => (
        <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 14 : 10 }}>
          {q.header && (
            <span
              style={{
                display: 'inline-block',
                fontFamily: T.mono,
                fontSize: 10.5,
                color: T.orange,
                background: T.orangeSoft,
                border: '1px solid rgba(217,98,43,0.3)',
                borderRadius: 6,
                padding: '1px 6px',
                marginBottom: 6,
              }}
            >
              {q.header}
            </span>
          )}
          <div
            style={{
              fontSize: 13.5,
              color: T.ink,
              fontWeight: 550,
              marginBottom: 8,
              lineHeight: 1.5,
            }}
          >
            {q.question}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {q.options.map((opt, oi) => {
              const selected = (picks[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={oi}
                  onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                  disabled={sent}
                  style={{
                    textAlign: 'left',
                    display: 'flex',
                    gap: 9,
                    alignItems: 'flex-start',
                    padding: '8px 10px',
                    borderRadius: 9,
                    border: `1.5px solid ${selected ? T.orange : T.lineSoft}`,
                    background: selected ? T.orangeSoft : T.paper,
                    cursor: sent ? 'default' : 'pointer',
                  }}
                >
                  <span
                    style={{
                      marginTop: 2,
                      width: 14,
                      height: 14,
                      flex: '0 0 auto',
                      borderRadius: q.multiSelect ? 4 : 99,
                      border: `1.5px solid ${selected ? T.orange : T.line}`,
                      background: selected ? T.orange : 'transparent',
                    }}
                  />
                  <span style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, color: T.ink, fontWeight: 550 }}>{opt.label}</span>
                    {opt.description && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          color: T.sub,
                          marginTop: 2,
                          lineHeight: 1.45,
                        }}
                      >
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            <input
              value={other[qi] ?? ''}
              onChange={(e) => setOther((prev) => ({ ...prev, [qi]: e.target.value }))}
              disabled={sent}
              placeholder="Other…"
              style={{
                fontSize: 12.5,
                padding: '7px 10px',
                borderRadius: 9,
                border: `1.5px solid ${T.lineSoft}`,
                background: T.paper,
                color: T.ink,
                outline: 'none',
              }}
            />
          </div>
        </div>
      ))}
      <button
        onClick={submit}
        disabled={!allAnswered || sent}
        style={{ ...btnPrimary, padding: '7px 14px', opacity: !allAnswered || sent ? 0.5 : 1 }}
      >
        {sent ? 'Sent' : 'Send answer'}
      </button>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: `1.5px solid ${T.orange}`,
  borderRadius: 11,
  padding: '12px 13px',
  background: T.card,
};

function Bubble({
  role,
  text,
  vm,
  onReveal,
  model,
}: {
  role: ChatMessage['role'];
  text: string;
  vm: AtlasVm;
  onReveal: (id: string) => void;
  model: string;
}): React.JSX.Element {
  const mine = role === 'user';
  const assistant = role === 'assistant';
  const { isPlan, clean } = assistant ? detectPlanProposal(text) : { isPlan: false, clean: text };
  const [planState, setPlanState] = useState<'idle' | 'creating'>('idle');
  // The project has ONE living plan document (decision 55): a proposal accepted while it exists
  // grows that document, so the button says so instead of promising a second plan.
  const hasPlan = [...vm.byId.values()].some((n) => n.kind === 'plan');

  const createPlan = (): void => {
    setPlanState('creating');
    void window.alethic.createPlan(clean, model);
  };

  return (
    <div
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: mine ? '88%' : '100%',
        minWidth: 0, // never let a long line grow the message past the panel
      }}
    >
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          // pre-wrap breaks at spaces only; a path, an id or a flag longer than the panel has no
          // space to break at and would escape the column. Allow a break anywhere inside such a run.
          overflowWrap: 'anywhere',
          // Only the user's own messages keep a bubble; assistant/system read as plain text (no
          // background, no border) like the VS Code / Claude Code transcript.
          padding: mine ? '8px 11px' : '2px 2px',
          borderRadius: mine ? 12 : 0,
          background: mine ? T.orangeSoft : 'transparent',
          border: mine ? '1.5px solid rgba(217,98,43,0.30)' : 'none',
          color: role === 'system' ? T.faint : T.ink,
        }}
      >
        {assistant ? <RichText text={clean} vm={vm} onReveal={onReveal} /> : text}
      </div>
      {isPlan && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={createPlan}
            disabled={planState === 'creating'}
            style={{
              ...btnPrimary,
              padding: '6px 12px',
              fontSize: 12,
              opacity: planState === 'creating' ? 0.6 : 1,
            }}
            title={
              hasPlan
                ? 'Add this work to the project plan as new items or a new phase'
                : 'Write this proposal into the project plan as phases you can execute'
            }
          >
            {hasPlan ? '＋ Add to plan' : '＋ Create plan'}
          </button>
          {planState === 'creating' && (
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint }}>
              {hasPlan
                ? 'Growing the plan — watch the plan node.'
                : 'Writing the plan — watch the pyramid.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'para'; text: string };

/** Minimal block parse of the markdown the agent emits: ATX headings, `-`/`*` bullets, paragraphs. */
function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = (): void => {
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') });
    para = [];
  };
  const flushList = (): void => {
    if (list.length) blocks.push({ type: 'list', items: list });
    list = [];
  };
  for (const line of src.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
    } else if (bullet) {
      flushPara();
      list.push(bullet[1]!);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/** Render an assistant reply as light markdown, with cited node ids as chips that teleport. */
function RichText({
  text,
  vm,
  onReveal,
}: {
  text: string;
  vm: AtlasVm;
  onReveal: (id: string) => void;
}): React.JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'heading')
          return (
            <div
              key={i}
              style={{
                fontFamily: T.serif,
                fontWeight: 600,
                color: T.ink,
                fontSize: b.level <= 1 ? 15 : b.level === 2 ? 14 : 13.5,
                marginTop: i === 0 ? 0 : 10,
                marginBottom: 2,
              }}
            >
              <Inline text={b.text} vm={vm} onReveal={onReveal} />
            </div>
          );
        if (b.type === 'list')
          return (
            <div
              key={i}
              style={{
                marginTop: i === 0 ? 0 : 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              {b.items.map((it, j) => (
                <div key={j} style={{ display: 'flex', gap: 6 }}>
                  <span style={{ color: T.faint }}>•</span>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <Inline text={it} vm={vm} onReveal={onReveal} />
                  </span>
                </div>
              ))}
            </div>
          );
        return (
          <div key={i} style={{ marginTop: i === 0 ? 0 : 8 }}>
            <Inline text={b.text} vm={vm} onReveal={onReveal} />
          </div>
        );
      })}
    </>
  );
}

/** Inline markdown within a block: **bold**, `code`, and cited-node chips. */
function Inline({
  text,
  vm,
  onReveal,
}: {
  text: string;
  vm: AtlasVm;
  onReveal: (id: string) => void;
}): React.JSX.Element {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last)
      out.push(<Fragment key={key++}>{withIds(text.slice(last, m.index), vm, onReveal)}</Fragment>);
    if (m[1] !== undefined)
      out.push(
        <strong key={key++} style={{ fontWeight: 650 }}>
          {withIds(m[1], vm, onReveal)}
        </strong>,
      );
    else
      out.push(
        <code
          key={key++}
          style={{
            fontFamily: T.mono,
            fontSize: 11.5,
            background: T.bg,
            borderRadius: 4,
            padding: '0 4px',
            overflowWrap: 'anywhere', // a long path/command breaks rather than widening the column
          }}
        >
          {m[2]}
        </code>,
      );
    last = m.index + m[0]!.length;
  }
  if (last < text.length)
    out.push(<Fragment key={key}>{withIds(text.slice(last), vm, onReveal)}</Fragment>);
  return <>{out}</>;
}

/** Split a plain run into text and clickable node-id chips. */
function withIds(text: string, vm: AtlasVm, onReveal: (id: string) => void): React.ReactNode[] {
  return segmentMessage(text, vm).map((seg, i) =>
    seg.nodeId ? (
      <span
        key={i}
        onClick={() => onReveal(seg.nodeId!)}
        title={vm.byId.get(seg.nodeId)?.title}
        style={{
          fontFamily: T.mono,
          fontSize: 11.5,
          color: T.blue,
          cursor: 'pointer',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
      >
        {vm.byId.get(seg.nodeId)?.title ?? seg.text}
      </span>
    ) : (
      <Fragment key={i}>{seg.text}</Fragment>
    ),
  );
}
