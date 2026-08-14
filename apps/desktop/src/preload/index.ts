// Preload — the only place the renderer's world touches Electron. Exposes a single typed
// `window.alethic` bridge built from the ipc client; contextIsolation keeps the rest sealed off.
import { contextBridge, ipcRenderer } from 'electron';
import { createIpcClient, type AlethicApi } from '@alethic/ipc';

const client = createIpcClient(ipcRenderer);

const api: AlethicApi = {
  openProject: (dir) => client.invoke('project:open', { dir }),
  setMode: (mode) => client.invoke('project:setMode', { mode }),
  pickProject: () => client.invoke('project:pick', undefined),
  pickFiles: () => client.invoke('dialog:pickFiles', undefined),
  recentProjects: () => client.invoke('project:recent', undefined),
  loadAtlas: () => client.invoke('atlas:load', undefined),
  onAtlasEvent: (callback) => client.subscribe('atlas:events', callback),
  onAppMenu: (callback) => client.subscribe('app:menu', callback),
  readCode: (file) => client.invoke('code:read', { file }),
  openExternal: (file) => client.invoke('code:openExternal', { file }),

  authStatus: () => client.invoke('auth:status', undefined),
  setApiKey: (key) => client.invoke('auth:setApiKey', { key }),
  disconnect: () => client.invoke('auth:disconnect', undefined),
  loginClaudeCode: () => client.invoke('auth:loginClaudeCode', undefined),
  listModels: () => client.invoke('models:list', undefined),
  sendMessage: (prompt, model, role, context) =>
    client.invoke('agent:send', {
      prompt,
      model,
      ...(role ? { role } : {}),
      ...(context ? { context } : {}),
    }),
  cancelTask: (taskId) => client.invoke('agent:cancel', { taskId }),
  activeTask: () => client.invoke('agent:active', undefined),
  respondPermission: (requestId, allow, message, remember) =>
    client.invoke('agent:permissionRespond', {
      requestId,
      allow,
      ...(message ? { message } : {}),
      ...(remember ? { remember } : {}),
    }),
  sessionGrants: () => client.invoke('agent:grants', undefined),
  setAutoAcceptEdits: (enabled) => client.invoke('agent:setAutoAccept', { enabled }),
  revokeGrant: (tool) => client.invoke('agent:revokeGrant', { tool }),
  chatHistory: () => client.invoke('chat:history', undefined),
  clearChat: () => client.invoke('chat:clear', undefined),
  compactChat: () => client.invoke('chat:compact', undefined),
  listLogs: () => client.invoke('logs:list', undefined),
  readLog: (file) => client.invoke('logs:read', { file }),
  collectDiagnostics: () => client.invoke('diagnostics:collect', undefined),
  checkForUpdate: () => client.invoke('update:check', undefined),
  onAgentEvent: (callback) => client.subscribe('agent:events', callback),
  onPermission: (callback) => client.subscribe('agent:permission', callback),

  scanPreview: () => client.invoke('scan:preview', undefined),
  scanDecompose: (model) => client.invoke('scan:decompose', { model }),
  scanStart: (model, domains, deep) =>
    client.invoke('scan:start', { model, domains, ...(deep ? { deep } : {}) }),
  scanCancel: () => client.invoke('scan:cancel', undefined),
  scanActive: () => client.invoke('scan:active', undefined),
  rescanDomain: (slug, model) => client.invoke('scan:rescanDomain', { slug, model }),
  deepenNode: (nodeId, model) => client.invoke('scan:deepen', { nodeId, model }),
  migrateNode: (nodeId, model) => client.invoke('scan:migrate', { nodeId, model }),
  onScanProgress: (callback) => client.subscribe('scan:progress', callback),

  runSync: (model) => client.invoke('sync:run', { model }),
  updateSpecFromCode: (nodeId, model) => client.invoke('drift:updateFromCode', { nodeId, model }),
  markRegression: (nodeId, model) => client.invoke('drift:markRegression', { nodeId, model }),
  saveNode: (edit) => client.invoke('spec:saveNode', edit),
  onSyncProgress: (callback) => client.subscribe('sync:progress', callback),

  createPlan: (message, model) => client.invoke('plan:create', { message, model }),
  startBuilding: (description, model, mode) =>
    client.invoke('plan:startBuilding', { description, model, ...(mode ? { mode } : {}) }),
  executePhase: (planId, phaseIndex, model) =>
    client.invoke('plan:executePhase', { planId, phaseIndex, model }),
  phaseStatus: (planId) => client.invoke('plan:phaseStatus', { planId }),
  mapCode: (model) => client.invoke('plan:mapCode', { model }),
  onPlanProgress: (callback) => client.subscribe('plan:progress', callback),

  terminalCreate: (cwd) => client.invoke('terminal:create', { ...(cwd ? { cwd } : {}) }),
  terminalInput: (id, data) => client.invoke('terminal:input', { id, data }),
  terminalResize: (id, cols, rows) => client.invoke('terminal:resize', { id, cols, rows }),
  terminalKill: (id) => client.invoke('terminal:kill', { id }),
  terminalList: () => client.invoke('terminal:list', undefined),
  onTerminalData: (callback) => client.subscribe('terminal:data', callback),
  onTerminalExit: (callback) => client.subscribe('terminal:exit', callback),

  processList: () => client.invoke('process:list', undefined),
  processStop: (id) => client.invoke('process:stop', { id }),

  gitStatus: () => client.invoke('git:status', undefined),
  gitStage: (files) => client.invoke('git:stage', { files }),
  gitUnstage: (files) => client.invoke('git:unstage', { files }),
  gitCommit: (message) => client.invoke('git:commit', { message }),
  gitPush: () => client.invoke('git:push', undefined),
  gitPull: () => client.invoke('git:pull', undefined),
  gitFileDiff: (file, staged) => client.invoke('git:fileDiff', { file, staged }),

  windowMinimize: () => client.invoke('window:minimize', undefined),
  windowToggleMaximize: () => client.invoke('window:toggleMaximize', undefined),
  windowClose: () => client.invoke('window:close', undefined),
  windowState: () => client.invoke('window:state', undefined),
  onWindowState: (callback) => client.subscribe('window:state', callback),
};

contextBridge.exposeInMainWorld('alethic', api);
