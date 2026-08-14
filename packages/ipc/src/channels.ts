// The channel catalogue. Request payloads carry zod schemas — validated at the main boundary
// (untrusted input from the renderer). Adding a channel here is the only way to create one.
import { z } from 'zod';

/** invoke channels: renderer asks, main answers. */
export const invokeChannels = {
  'project:open': { request: z.object({ dir: z.string().min(1) }) },
  'project:setMode': { request: z.object({ mode: z.enum(['dev', 'plan']) }) },
  'project:pick': { request: z.void() },
  'dialog:pickFiles': { request: z.void() },
  'project:recent': { request: z.void() },
  'atlas:load': { request: z.void() },
  'code:read': { request: z.object({ file: z.string().min(1) }) },
  'code:openExternal': { request: z.object({ file: z.string().min(1) }) },
  'agent:active': { request: z.void() },
  'auth:status': { request: z.void() },
  'auth:setApiKey': { request: z.object({ key: z.string().min(1) }) },
  'auth:disconnect': { request: z.void() },
  'auth:loginClaudeCode': { request: z.void() },
  'models:list': { request: z.void() },
  'agent:send': {
    request: z.object({
      prompt: z.string().min(1),
      model: z.string().min(1),
      role: z.string().optional(),
      context: z.string().optional(), // light map/view context for the Navigator (decision 20)
    }),
  },
  'agent:cancel': { request: z.object({ taskId: z.string() }) },
  'agent:permissionRespond': {
    request: z.object({
      requestId: z.string(),
      allow: z.boolean(),
      message: z.string().optional(),
      // "don't ask again this session" for this tool (decision 1)
      remember: z.boolean().optional(),
    }),
  },
  // what runs unattended right now, and the two ways to change it (decision 1)
  'agent:grants': { request: z.void() },
  'agent:setAutoAccept': { request: z.object({ enabled: z.boolean() }) },
  'agent:revokeGrant': { request: z.object({ tool: z.string().min(1) }) },
  'chat:history': { request: z.void() },
  'chat:clear': { request: z.void() },
  'chat:compact': { request: z.void() },
  'logs:list': { request: z.void() },
  'logs:read': { request: z.object({ file: z.string().min(1) }) },

  // delivery (Phase 11): diagnostics + static update check
  'diagnostics:collect': { request: z.void() },
  'update:check': { request: z.void() },

  // scan flow (Phase 6)
  'scan:preview': { request: z.void() },
  'scan:decompose': { request: z.object({ model: z.string().min(1) }) },
  'scan:start': {
    request: z.object({
      model: z.string().min(1),
      domains: z
        .array(
          z.object({
            slug: z.string().min(1),
            title: z.string().min(1),
            description: z.string().optional(),
            scope: z.array(z.string()).min(1),
          }),
        )
        .min(1),
      deep: z.array(z.string()).optional(), // slugs to scan deeply; the rest go shallow
    }),
  },
  'scan:cancel': { request: z.void() },
  'scan:active': { request: z.void() },
  'scan:rescanDomain': { request: z.object({ slug: z.string().min(1), model: z.string().min(1) }) },
  'scan:deepen': { request: z.object({ nodeId: z.string().min(1), model: z.string().min(1) }) },
  // Migrate a branch mapped before decision 56 into features (Phase 6).
  'scan:migrate': { request: z.object({ nodeId: z.string().min(1), model: z.string().min(1) }) },

  // liveness (Phase 7)
  'sync:run': { request: z.object({ model: z.string().min(1) }) },
  'drift:updateFromCode': {
    request: z.object({ nodeId: z.string().min(1), model: z.string().min(1) }),
  },
  'drift:markRegression': {
    request: z.object({ nodeId: z.string().min(1), model: z.string().min(1) }),
  },
  'spec:saveNode': {
    request: z.object({
      path: z.string().min(1),
      title: z.string().optional(),
      body: z.string(),
      expectedUpdated: z.string().optional(),
      force: z.boolean().optional(),
    }),
  },

  // planning & execution (Phase 9)
  'plan:create': { request: z.object({ message: z.string().min(1), model: z.string().min(1) }) },
  'plan:startBuilding': {
    request: z.object({
      description: z.string().min(1),
      model: z.string().min(1),
      mode: z.enum(['dev', 'plan']).optional(),
    }),
  },
  'plan:executePhase': {
    request: z.object({
      planId: z.string().min(1),
      phaseIndex: z.number().int().min(0),
      model: z.string().min(1),
    }),
  },
  'plan:phaseStatus': { request: z.object({ planId: z.string().min(1) }) },
  'plan:mapCode': { request: z.object({ model: z.string().min(1) }) },

  // environment: terminal, processes, git panel (Phase 10)
  'terminal:create': { request: z.object({ cwd: z.string().optional() }) },
  'terminal:input': { request: z.object({ id: z.string().min(1), data: z.string() }) },
  'terminal:resize': {
    request: z.object({ id: z.string().min(1), cols: z.number(), rows: z.number() }),
  },
  'terminal:kill': { request: z.object({ id: z.string().min(1) }) },
  'terminal:list': { request: z.void() },
  'process:list': { request: z.void() },
  'process:stop': { request: z.object({ id: z.string().min(1) }) },
  'git:status': { request: z.void() },
  'git:stage': { request: z.object({ files: z.array(z.string()) }) },
  'git:unstage': { request: z.object({ files: z.array(z.string()) }) },
  'git:commit': { request: z.object({ message: z.string().min(1) }) },
  'git:push': { request: z.void() },
  'git:pull': { request: z.void() },
  'git:fileDiff': { request: z.object({ file: z.string().min(1), staged: z.boolean() }) },

  // window chrome — the app draws its own title bar (frameless), so the controls are ours
  'window:minimize': { request: z.void() },
  'window:toggleMaximize': { request: z.void() },
  'window:close': { request: z.void() },
  'window:state': { request: z.void() },
} as const;

/** event channels: main pushes a stream to the renderer. */
export const eventChannels = [
  'app:menu',
  'atlas:events',
  'agent:events',
  'agent:permission',
  'scan:progress',
  'sync:progress',
  'plan:progress',
  'terminal:data',
  'terminal:exit',
  'window:state',
] as const;
