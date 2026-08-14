// The end-to-end types derived from the channel catalogue: request in, response out, event payload.
// Requests infer from their zod schema; responses/events are named here.
import type { z } from 'zod';
import type { invokeChannels, eventChannels } from './channels.js';
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

export type InvokeChannel = keyof typeof invokeChannels;

export interface InvokeResponses {
  'project:open': AtlasSnapshot;
  'project:setMode': AtlasSnapshot | null;
  'project:pick': string | null;
  'dialog:pickFiles': AttachedFile[];
  'project:recent': RecentProject[];
  'atlas:load': AtlasSnapshot | null;
  'code:read': CodeFile | null;
  'code:openExternal': boolean;
  'agent:active': { taskId: string | null };
  'auth:status': AuthStatus;
  'auth:setApiKey': AuthStatus;
  'auth:disconnect': AuthStatus;
  'auth:loginClaudeCode': { started: boolean; error?: string };
  'models:list': ModelOption[];
  'agent:send': { taskId: string };
  'agent:cancel': void;
  'agent:permissionRespond': void;
  'agent:grants': SessionGrants;
  'agent:setAutoAccept': SessionGrants;
  'agent:revokeGrant': SessionGrants;
  'chat:history': ChatMessage[];
  'chat:clear': void;
  'chat:compact': ChatMessage[];
  'logs:list': RunLogEntry[];
  'logs:read': RunLogContent | null;
  'diagnostics:collect': string;
  'update:check': UpdateInfo;
  'scan:preview': ScanPreview;
  'scan:decompose': DomainProposal[];
  'scan:start': { started: boolean };
  'scan:cancel': void;
  'scan:active': ScanActivity;
  'scan:rescanDomain': { started: boolean };
  'scan:deepen': { started: boolean };
  'scan:migrate': { started: boolean };
  'sync:run': SyncResult;
  'drift:updateFromCode': { started: boolean };
  'drift:markRegression': { started: boolean };
  'spec:saveNode': SaveNodeResult;
  'plan:create': { taskId: string };
  'plan:startBuilding': { started: boolean; taskId: string };
  'plan:executePhase': { started: boolean };
  'plan:phaseStatus': { running: number[]; queued: number[] };
  'plan:mapCode': { started: boolean };
  'terminal:create': TerminalSessionInfo;
  'terminal:input': void;
  'terminal:resize': void;
  'terminal:kill': void;
  'terminal:list': TerminalSessionInfo[];
  'process:list': ProcessInfo[];
  'process:stop': void;
  'git:status': GitStatus | null;
  'git:stage': void;
  'git:unstage': void;
  'git:commit': void;
  'git:push': void;
  'git:pull': void;
  'git:fileDiff': GitFileDiff;
  'window:minimize': void;
  'window:toggleMaximize': void;
  'window:close': void;
  'window:state': WindowState;
}

export type InvokeRequest<C extends InvokeChannel> = z.infer<(typeof invokeChannels)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = InvokeResponses[C];

export type EventChannel = (typeof eventChannels)[number];

export interface EventPayloads {
  'app:menu': AppMenuEvent;
  'atlas:events': AtlasEvent;
  'agent:events': AgentStreamMessage;
  'agent:permission': PermissionRequest;
  'scan:progress': ScanProgress;
  'sync:progress': SyncProgress;
  'plan:progress': PlanProgress;
  'terminal:data': TerminalData;
  'terminal:exit': TerminalExit;
  'window:state': WindowState;
}

export type EventPayload<E extends EventChannel> = EventPayloads[E];
