// packages/ipc — the shared vocabulary of typed channels between main and renderer.
export const IPC_PROTOCOL_VERSION = 1 as const;

export * from './types.js';
export * from './channels.js';
export * from './contract.js';
export * from './transport.js';
export * from './server.js';
export * from './client.js';
export * from './api.js';
