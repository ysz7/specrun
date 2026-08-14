// Main process — the composition root. Every service is created and wired to its peers here, in
// one file, with no DI container: 3 services, hand-composed, read top to bottom (constitution rule 3).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  screen,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { createEventSender, createIpcServer } from '@alethic/ipc';
import type { ChatStep } from '@alethic/ipc';
import { MODELS, SdkAgentEngine, SpecStore } from '@alethic/agent';
import { AtlasService } from './services/atlas.service';
import { StoreService } from './services/store.service';
import { AuthService } from './services/auth.service';
import { ChatService } from './services/chat.service';
import { AgentService } from './services/agent.service';
import { ScanService } from './services/scan.service';
import { SyncService } from './services/sync.service';
import { PlanService } from './services/plan.service';
import { PlanningFlow } from './services/planning-flow';
import { TerminalService } from './services/terminal.service';
import { ProcessService } from './services/process.service';
import { GitPanelService } from './services/git-panel.service';
import { NotificationService } from './services/notification.service';
import { UpdateService } from './services/update.service';

const atlas = new AtlasService();
const store = new StoreService();
const auth = new AuthService();
const chat = new ChatService();
const engine = new SdkAgentEngine();
const logsDir = join(app.getPath('userData'), 'logs');
const agent = new AgentService(engine, logsDir);
const scan = new ScanService(engine, undefined, logsDir);
const sync = new SyncService(engine);
const plan = new PlanService();
const planning = new PlanningFlow(agent, plan);
const terminal = new TerminalService();
const processes = new ProcessService(terminal);
const gitPanel = new GitPanelService();
const update = new UpdateService(app.getVersion());
const notifications = new NotificationService(
  () => mainWindow?.isFocused() ?? false,
  (title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  },
);

let mainWindow: BrowserWindow | null = null;
const sender = createEventSender(() => mainWindow?.webContents ?? undefined);

function openProject(dir: string): ReturnType<AtlasService['open']> {
  plan.setProject(dir);
  plan.ensureSections(); // decision 55: an existing map grows its Plan/Code branches on open
  const snapshot = atlas.open(dir);
  store.rememberProject(dir);
  chat.setProject(dir);
  // Chat is keyed by path, but a folder whose map is empty is a fresh start (new or cleared):
  // don't resurrect an old conversation that cites nodes which no longer exist. A normal reopen —
  // where the map is still there — keeps its history (decisions 23, 37).
  if (Object.keys(snapshot.index.nodes).length === 0) chat.clear();
  agent.setProject(dir);
  scan.setProject(dir);
  sync.setProject(dir);
  terminal.setProject(dir);
  gitPanel.setProject(dir);
  buildMenu(); // refresh the Open Recent submenu
  return snapshot;
}

/** What the custom title bar renders from (see WindowState). */
function windowState(): { maximized: boolean; customControls: boolean } {
  return {
    maximized: mainWindow?.isMaximized() ?? false,
    customControls: process.platform !== 'darwin',
  };
}

/**
 * The native application menu (decision 37). Only macOS keeps one: there the menu bar lives in the
 * system bar and is expected. On Windows/Linux the window is frameless, so a menu bar would never
 * be drawn — the title bar's ☰ button offers the same actions, and their accelerators are handled
 * in the renderer.
 */
function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const recent = store.recentProjects();
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sender.send('app:menu', { action: 'open-folder' }),
        },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map((r) => ({
                label: r.name || r.path,
                sublabel: r.path,
                click: () => sender.send('app:menu', { action: 'open-recent', path: r.path }),
              }))
            : [{ label: 'No recent projects', enabled: false }],
        },
        { type: 'separator' },
        {
          label: 'Close Project',
          accelerator: 'CmdOrCtrl+W',
          click: () => sender.send('app:menu', { action: 'close-project' }),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** In dev, fall back to the bundled acme fixture so there is always a map to look at. */
function initialProjectDir(): string | null {
  if (process.env['ALETHIC_PROJECT']) return process.env['ALETHIC_PROJECT'];
  const recent = store.recentProjects()[0];
  if (recent && existsSync(join(recent.path, '.alethic'))) return recent.path;
  const fixture = resolve(app.getAppPath(), '..', '..', 'fixtures', 'acme-commerce');
  return existsSync(join(fixture, '.alethic')) ? fixture : null;
}

function registerIpc(): void {
  const server = createIpcServer(ipcMain);
  server.handle('project:open', ({ dir }) => openProject(dir));
  server.handle('project:setMode', ({ mode }) => {
    plan.setMode(mode); // persist to config.yaml
    atlas.setMode(mode); // reflect in the live snapshot
    return atlas.snapshot();
  });
  server.handle('project:recent', () => store.recentProjects());
  server.handle('atlas:load', () => atlas.snapshot());

  server.handle('project:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Attach files to a chat message: pick (multi-select) and read, capped so a huge file can't
  // blow up the prompt. The user chose these explicitly, so reading outside the root is intended.
  server.handle('dialog:pickFiles', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    const CAP = 100_000; // ~100 KB of text per file is plenty of context
    const files = await Promise.all(
      result.filePaths.map(async (p) => {
        try {
          const text = await readFile(p, 'utf8');
          return { path: p, name: p.split(/[\\/]/).pop() ?? p, text: text.slice(0, CAP) };
        } catch {
          return null;
        }
      }),
    );
    return files.filter((f): f is NonNullable<typeof f> => f !== null);
  });

  server.handle('code:read', async ({ file }) => {
    const root = atlas.projectRoot();
    if (!root) return null;
    const abs = resolve(root, file);
    // guard against path traversal outside the project root
    if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) return null;
    try {
      return { path: file, text: await readFile(abs, 'utf8') };
    } catch {
      return null;
    }
  });

  server.handle('code:openExternal', async ({ file }) => {
    const root = atlas.projectRoot();
    if (!root) return false;
    const abs = resolve(root, file);
    if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) return false;
    const error = await shell.openPath(abs);
    return error === '';
  });

  // ── auth / models / chat / agent (Phase 4) ──
  server.handle('auth:status', () => auth.status());
  server.handle('auth:setApiKey', ({ key }) => auth.setApiKey(key));
  server.handle('auth:disconnect', () => auth.disconnect());
  server.handle('auth:loginClaudeCode', () => auth.loginClaudeCode());
  server.handle('models:list', () => [...MODELS]);

  server.handle('agent:send', ({ prompt, model, role, context }) => {
    // The chat history stores only what the user typed; the light view context (decision 20) is
    // prepended to what the agent actually receives, so history stays clean.
    chat.append({ id: randomUUID(), role: 'user', text: prompt, ts: new Date().toISOString() });
    const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
    return agent.send({ prompt: fullPrompt, model, role });
  });
  server.handle('agent:cancel', ({ taskId }) => agent.cancel(taskId));
  server.handle('agent:active', () => agent.activeTask());
  server.handle('agent:permissionRespond', ({ requestId, allow, message, remember }) =>
    agent.respondPermission(requestId, allow, message, remember),
  );
  server.handle('agent:grants', () => agent.sessionGrants());
  server.handle('agent:setAutoAccept', ({ enabled }) => agent.setAutoAcceptEdits(enabled));
  server.handle('agent:revokeGrant', ({ tool }) => agent.revokeGrant(tool));
  server.handle('chat:history', () => chat.history());
  server.handle('chat:clear', () => chat.clear());
  server.handle('chat:compact', () => chat.compact());
  server.handle('logs:list', () => agent.listLogs());
  server.handle('logs:read', ({ file }) => agent.readLog(file));

  // ── delivery: diagnostics + update check (Phase 11) ──
  server.handle('diagnostics:collect', async () => {
    const logs = agent.listLogs();
    const authStatus = await auth.status();
    const lastError = agent.lastError();
    return [
      `Alethic ${app.getVersion()}`,
      `Electron ${process.versions.electron} · Node ${process.versions.node} · Chrome ${process.versions.chrome}`,
      `Platform ${process.platform} ${process.arch} · locale ${app.getLocale()}`,
      `Claude: ${authStatus.connected ? authStatus.method : 'not connected'}`,
      `Project: ${atlas.projectRoot() ?? '(none open)'}`,
      `Last error: ${lastError ? `${lastError.ts} — ${lastError.message}` : '(none this session)'}`,
      `Recent runs: ${logs.length}`,
      ...logs.slice(0, 10).map((l) => `  · ${l.startedAt} ${l.role}/${l.model} ${l.file}`),
    ].join('\n');
  });
  server.handle('update:check', () => update.check());

  // ── scan flow (Phase 6) ──
  server.handle('scan:preview', () => scan.preview());
  server.handle('scan:decompose', ({ model }) => scan.decompose(model));
  server.handle('scan:start', ({ model, domains, deep }) => scan.start(model, domains, deep ?? []));
  server.handle('scan:cancel', () => scan.cancel());
  server.handle('scan:active', () => scan.active());
  server.handle('scan:rescanDomain', ({ slug, model }) => scan.rescanDomain(slug, model));
  server.handle('scan:deepen', ({ nodeId, model }) => scan.deepen(nodeId, model));
  server.handle('scan:migrate', ({ nodeId, model }) => scan.migrate(nodeId, model));

  // ── liveness (Phase 7) ──
  server.handle('sync:run', ({ model }) => sync.sync(model));
  server.handle('drift:updateFromCode', ({ nodeId, model }) => {
    const task = sync.buildUpdateFromCodeTask(nodeId);
    if (!task) return { started: false };
    scan.backup(); // snapshot before a destructive spec write (decision 43)
    agent.send({ prompt: task.prompt, model, role: task.role });
    return { started: true };
  });
  server.handle('drift:markRegression', ({ nodeId, model }) => {
    const task = sync.buildRegressionTask(nodeId);
    if (!task) return { started: false };
    agent.send({ prompt: task.prompt, model, role: task.role });
    return { started: true };
  });
  server.handle('spec:saveNode', ({ path, title, body, expectedUpdated, force }) => {
    const root = atlas.projectRoot();
    if (!root) throw new Error('No project is open.');
    const specStore = new SpecStore(join(root, '.alethic'));
    return specStore.saveHuman(
      path,
      { ...(title !== undefined ? { title } : {}), body },
      expectedUpdated,
      force ?? false,
    );
  });

  // ── planning & execution (Phase 9) ──
  server.handle('plan:create', ({ message, model }) => planning.createPlan(message, model));
  server.handle('plan:startBuilding', ({ description, model, mode }) => {
    const chosen = mode ?? 'dev';
    const result = planning.startBuilding(description, model, chosen);
    atlas.setMode(chosen); // keep the open snapshot's mode in sync with what we just wrote
    return result;
  });
  server.handle('plan:executePhase', ({ planId, phaseIndex, model }) =>
    planning.executePhase(planId, phaseIndex, model),
  );
  server.handle('plan:mapCode', ({ model }) => planning.mapCode(model));
  server.handle('plan:phaseStatus', ({ planId }) => planning.phaseStatus(planId));

  // ── environment: terminal, processes, git panel (Phase 10) ──
  server.handle('terminal:create', ({ cwd }) => terminal.create(cwd));
  server.handle('terminal:input', ({ id, data }) => terminal.write(id, data));
  server.handle('terminal:resize', ({ id, cols, rows }) => terminal.resize(id, cols, rows));
  server.handle('terminal:kill', ({ id }) => terminal.kill(id));
  server.handle('terminal:list', () => terminal.list());
  server.handle('process:list', () => processes.list());
  server.handle('process:stop', ({ id }) => processes.stop(id));
  server.handle('git:status', () => gitPanel.status());
  server.handle('git:stage', ({ files }) => gitPanel.stage(files));
  server.handle('git:unstage', ({ files }) => gitPanel.unstage(files));
  server.handle('git:commit', ({ message }) => gitPanel.commit(message));
  server.handle('git:push', () => gitPanel.push());
  server.handle('git:pull', () => gitPanel.pull());
  server.handle('git:fileDiff', ({ file, staged }) => gitPanel.fileDiff(file, staged));

  // ── window chrome (the title bar is drawn by the renderer) ──
  server.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
  server.handle('window:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  server.handle('window:close', () => {
    mainWindow?.close();
  });
  server.handle('window:state', () => windowState());

  atlas.onEvent((event) => sender.send('atlas:events', event));
  scan.onProgress((progress) => {
    sender.send('scan:progress', progress);
    if (progress.phase === 'done')
      notifications.notify('Scan complete', 'Your project map is ready.'); // decision 50
  });
  sync.onProgress((progress) => sender.send('sync:progress', progress));
  plan.onProgress((progress) => {
    sender.send('plan:progress', progress);
    if (progress.phase === 'done')
      notifications.notify('Phase done', `${progress.phaseTitle ?? 'A phase'} finished.`); // decision 50
    if (progress.phase === 'blocked')
      notifications.notify('Phase blocked', progress.message ?? 'A phase needs your attention.');
  });
  terminal.onData((id, data) => sender.send('terminal:data', { id, data }));
  terminal.onExit((id, code) => sender.send('terminal:exit', { id, code }));

  // Post-scan calibration (decision 40): ask the user to check the three most central rules.
  scan.onCalibration((rules) => {
    if (rules.length === 0) return;
    const text = [
      'Scan complete. Here are the three most central rules I wrote — please check me:',
      ...rules.map((r, i) => `${i + 1}. ${r.title}  (${r.path})`),
      '',
      'If any of these is wrong, tell me and I will rescan that domain.',
    ].join('\n');
    const message = {
      id: `calib-${Date.now()}`,
      role: 'assistant' as const,
      text,
      ts: new Date().toISOString(),
    };
    chat.append(message);
    sender.send('agent:events', { taskId: message.id, type: 'text', text });
    sender.send('agent:events', { taskId: message.id, type: 'done', ok: true });
  });

  // Stream agent events to the renderer and persist the whole assistant turn (text + tool chain) per
  // task, so history renders like the live transcript (decision 23). Kept in the local chat store.
  type Built =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; name: string; input: unknown; status: 'running' | 'done' | 'error' };
  const chains = new Map<string, Built[]>();
  const chainFor = (taskId: string): Built[] => {
    const c = chains.get(taskId) ?? [];
    if (!chains.has(taskId)) chains.set(taskId, c);
    return c;
  };
  agent.onEvent((event) => {
    sender.send('agent:events', event);
    planning.handleAgentEvent(event); // ticks the phase + maps its code when an executor run lands
    // Mirror the agent's bash commands into the read-only Executor terminal tab (decision 45).
    if (event.type === 'tool' && event.name === 'Bash') {
      const cmd = (event.input as { command?: string } | null)?.command;
      if (cmd) terminal.feedExecutor(`$ ${cmd}`);
    }
    if (event.type === 'text') {
      const c = chainFor(event.taskId);
      const last = c[c.length - 1];
      if (last?.kind === 'text') last.text += event.text;
      else c.push({ kind: 'text', text: event.text });
    } else if (event.type === 'tool') {
      chainFor(event.taskId).push({
        kind: 'tool',
        name: event.name,
        input: event.input,
        status: 'running',
      });
    } else if (event.type === 'tool-result') {
      const c = chains.get(event.taskId);
      const pending =
        c && [...c].reverse().find((s) => s.kind === 'tool' && s.status === 'running');
      if (pending && pending.kind === 'tool') pending.status = event.isError ? 'error' : 'done';
    } else if (event.type === 'done' || event.type === 'error') {
      const c = chains.get(event.taskId) ?? [];
      const steps: ChatStep[] = c.map((s) =>
        s.kind === 'text'
          ? { kind: 'text', text: s.text }
          : {
              kind: 'tool',
              name: s.name,
              input: s.input,
              status: s.status === 'error' ? 'error' : 'done',
            },
      );
      const text = c
        .filter((s): s is Extract<Built, { kind: 'text' }> => s.kind === 'text')
        .map((s) => s.text)
        .join('')
        .trim();
      const finalText = text || (event.type === 'error' ? `⚠ ${event.message}` : '');
      if (finalText && !steps.some((s) => s.kind === 'text'))
        steps.push({ kind: 'text', text: finalText });
      if (finalText || steps.length)
        chat.append({
          id: event.taskId,
          role: 'assistant',
          text: finalText,
          ts: new Date().toISOString(),
          steps,
        });
      chains.delete(event.taskId);
    }
  });
  agent.onPermission((request) => {
    sender.send('agent:permission', request);
    notifications.notify('Permission needed', `The agent wants to use ${request.toolName}.`); // decision 50
  });
}

/** Window bounds: a size, plus a position once the user has moved the window. */
type WindowBounds = { width: number; height: number; x?: number; y?: number };

/**
 * The size to open at when the user has no remembered bounds. Fixed, then capped by the display's
 * work area (taskbar excluded) — the cap only bites on a screen too small to hold it, so nothing
 * ever opens larger than the desktop it lands on.
 */
const DEFAULT_WINDOW = { width: 1250, height: 725 };

function defaultBounds(): WindowBounds {
  const work = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(DEFAULT_WINDOW.width, work.width),
    height: Math.min(DEFAULT_WINDOW.height, work.height),
  };
}

function createWindow(): void {
  const bounds = store.windowState() ?? defaultBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    // A first run (or a reset of the saved bounds) opens centered; once the user has moved the
    // window, their own position wins. The check stays inline so x/y narrow away their `undefined`.
    ...(bounds.x !== undefined && bounds.y !== undefined
      ? { x: bounds.x, y: bounds.y }
      : { center: true }),
    minWidth: 720, // below this the pyramid and the chat dock start fighting over the same pixels
    minHeight: 520,
    show: false,
    backgroundColor: '#F7F4ED',
    // The app draws its own title bar. On Windows/Linux that means no frame at all (the renderer
    // supplies minimize/maximize/close); on macOS the traffic lights stay native and only the bar
    // itself is ours, because a mac window without them is a window you cannot close.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  // Keep the title bar's maximize/restore glyph honest, including when the user double-clicks the
  // bar or snaps the window with the keyboard — neither goes through our IPC.
  const pushWindowState = (): void => sender.send('window:state', windowState());
  mainWindow.on('maximize', pushWindowState);
  mainWindow.on('unmaximize', pushWindowState);
  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const { width, height, x, y } = mainWindow.getBounds();
    store.saveWindowState({ width, height, x, y });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  registerIpc();

  const dir = initialProjectDir();
  if (dir) openProject(dir);
  buildMenu(); // ensure the menu exists even when no project auto-opens

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  atlas.close();
  terminal.killAll(); // don't leave a `npm run dev` orphaned (decision 46)
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => terminal.killAll());
