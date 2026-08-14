// The bridge surface exposed on `window.alethic` by preload. The renderer depends only on this
// interface (type-only) — its single, typed window onto main.
import type {
  AgentStreamMessage,
  AppMenuEvent,
  AtlasEvent,
  AtlasSnapshot,
  AttachedFile,
  AuthStatus,
  ChatMessage,
  CodeFile,
  DomainProposal,
  GitFileDiff,
  GitStatus,
  ModelOption,
  PermissionRequest,
  PlanProgress,
  ProcessInfo,
  RecentProject,
  RunLogContent,
  RunLogEntry,
  SaveNodeResult,
  ScanPreview,
  ScanActivity,
  ScanProgress,
  SessionGrants,
  SyncProgress,
  SyncResult,
  TerminalData,
  TerminalExit,
  TerminalSessionInfo,
  UpdateInfo,
  WindowState,
} from './types.js';

export interface AlethicApi {
  openProject(dir: string): Promise<AtlasSnapshot>;
  setMode(mode: 'dev' | 'plan'): Promise<AtlasSnapshot | null>;
  pickProject(): Promise<string | null>;
  pickFiles(): Promise<AttachedFile[]>;
  recentProjects(): Promise<RecentProject[]>;
  loadAtlas(): Promise<AtlasSnapshot | null>;
  onAtlasEvent(callback: (event: AtlasEvent) => void): () => void;
  onAppMenu(callback: (event: AppMenuEvent) => void): () => void;
  readCode(file: string): Promise<CodeFile | null>;
  openExternal(file: string): Promise<boolean>;

  // agent / auth / chat (Phase 4)
  authStatus(): Promise<AuthStatus>;
  setApiKey(key: string): Promise<AuthStatus>;
  disconnect(): Promise<AuthStatus>;
  loginClaudeCode(): Promise<{ started: boolean; error?: string }>;
  listModels(): Promise<ModelOption[]>;
  sendMessage(
    prompt: string,
    model: string,
    role?: string,
    context?: string,
  ): Promise<{ taskId: string }>;
  cancelTask(taskId: string): Promise<void>;
  activeTask(): Promise<{ taskId: string | null }>;
  /** Answer a permission prompt; `remember` grants the tool for the rest of the session. */
  respondPermission(
    requestId: string,
    allow: boolean,
    message?: string,
    remember?: boolean,
  ): Promise<void>;
  /** What currently runs without asking, so Settings can show it (decision 1). */
  sessionGrants(): Promise<SessionGrants>;
  /** Switch auto-accept-edits on ahead of time, rather than reaching it from a permission card. */
  setAutoAcceptEdits(enabled: boolean): Promise<SessionGrants>;
  /** Take back one "Allow this session" grant. */
  revokeGrant(tool: string): Promise<SessionGrants>;
  chatHistory(): Promise<ChatMessage[]>;
  clearChat(): Promise<void>;
  compactChat(): Promise<ChatMessage[]>;
  listLogs(): Promise<RunLogEntry[]>;
  readLog(file: string): Promise<RunLogContent | null>;
  collectDiagnostics(): Promise<string>;
  checkForUpdate(): Promise<UpdateInfo>;
  onAgentEvent(callback: (event: AgentStreamMessage) => void): () => void;
  onPermission(callback: (request: PermissionRequest) => void): () => void;

  // scan flow (Phase 6)
  scanPreview(): Promise<ScanPreview>;
  scanDecompose(model: string): Promise<DomainProposal[]>;
  scanStart(
    model: string,
    domains: DomainProposal[],
    deep?: string[],
  ): Promise<{ started: boolean }>;
  scanCancel(): Promise<void>;
  /** Is a scan pass in flight? For panels that open mid-scan and must not offer a second one. */
  scanActive(): Promise<ScanActivity>;
  rescanDomain(slug: string, model: string): Promise<{ started: boolean }>;
  deepenNode(nodeId: string, model: string): Promise<{ started: boolean }>;
  /** Fold a branch still mapped as one-sentence-per-node into features (decision 56, Phase 6). */
  migrateNode(nodeId: string, model: string): Promise<{ started: boolean }>;
  onScanProgress(callback: (progress: ScanProgress) => void): () => void;

  // liveness (Phase 7)
  runSync(model: string): Promise<SyncResult>;
  updateSpecFromCode(nodeId: string, model: string): Promise<{ started: boolean }>;
  markRegression(nodeId: string, model: string): Promise<{ started: boolean }>;
  saveNode(edit: {
    path: string;
    title?: string;
    body: string;
    expectedUpdated?: string;
    force?: boolean;
  }): Promise<SaveNodeResult>;
  onSyncProgress(callback: (progress: SyncProgress) => void): () => void;

  // planning & execution (Phase 9)
  createPlan(message: string, model: string): Promise<{ taskId: string }>;
  startBuilding(
    description: string,
    model: string,
    mode?: 'dev' | 'plan',
  ): Promise<{ started: boolean; taskId: string }>;
  executePhase(planId: string, phaseIndex: number, model: string): Promise<{ started: boolean }>;
  phaseStatus(planId: string): Promise<{ running: number[]; queued: number[] }>;
  /** Rescan the code into map rules on demand (decision 55: the Code branch comes from the code). */
  mapCode(model: string): Promise<{ started: boolean }>;
  onPlanProgress(callback: (progress: PlanProgress) => void): () => void;

  // environment: terminal, processes, git panel (Phase 10)
  terminalCreate(cwd?: string): Promise<TerminalSessionInfo>;
  terminalInput(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalKill(id: string): Promise<void>;
  terminalList(): Promise<TerminalSessionInfo[]>;
  onTerminalData(callback: (data: TerminalData) => void): () => void;
  onTerminalExit(callback: (exit: TerminalExit) => void): () => void;

  processList(): Promise<ProcessInfo[]>;
  processStop(id: string): Promise<void>;

  gitStatus(): Promise<GitStatus | null>;
  gitStage(files: string[]): Promise<void>;
  gitUnstage(files: string[]): Promise<void>;
  gitCommit(message: string): Promise<void>;
  gitPush(): Promise<void>;
  gitPull(): Promise<void>;
  gitFileDiff(file: string, staged: boolean): Promise<GitFileDiff>;

  // window chrome — the title bar is ours to draw (frameless on Windows/Linux)
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  windowState(): Promise<WindowState>;
  onWindowState(callback: (state: WindowState) => void): () => void;
}

declare global {
  interface Window {
    alethic: AlethicApi;
  }
}
