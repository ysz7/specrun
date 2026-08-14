import { describe, expect, it, vi } from 'vitest';
import {
  createEventSender,
  createIpcClient,
  createIpcServer,
  IPC_PROTOCOL_VERSION,
} from './index.js';
import type { IpcRendererListener } from './transport.js';

// A single in-memory object playing ipcMain (handle), ipcRenderer (invoke/on/removeListener) and
// webContents (send) — enough to wire a server and client together end to end.
class FakeIpc {
  private readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  private readonly listeners = new Map<string, Set<IpcRendererListener>>();

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
  on(channel: string, listener: IpcRendererListener): void {
    (this.listeners.get(channel) ?? this.listeners.set(channel, new Set()).get(channel)!).add(
      listener,
    );
  }
  removeListener(channel: string, listener: IpcRendererListener): void {
    this.listeners.get(channel)?.delete(listener);
  }
  send(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({}, ...args);
  }
}

describe('ipc contract', () => {
  it('declares protocol version 1', () => {
    expect(IPC_PROTOCOL_VERSION).toBe(1);
  });

  it('round-trips a typed invoke through server + client', async () => {
    const ipc = new FakeIpc();
    createIpcServer(ipc).handle('project:recent', () => [
      { path: '/p', name: 'p', lastOpened: '2026-07-10T00:00:00Z' },
    ]);
    const client = createIpcClient(ipc);
    const recent = await client.invoke('project:recent', undefined);
    expect(recent).toEqual([{ path: '/p', name: 'p', lastOpened: '2026-07-10T00:00:00Z' }]);
  });

  it('rejects a request that fails zod validation at the boundary', async () => {
    const ipc = new FakeIpc();
    const handler = vi.fn();
    createIpcServer(ipc).handle('project:open', handler as never);
    const client = createIpcClient(ipc);
    await expect(client.invoke('project:open', { dir: '' })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled(); // never reached the handler
  });

  it('delivers typed events to subscribers and stops after unsubscribe', () => {
    const ipc = new FakeIpc();
    const sender = createEventSender(() => ipc);
    const client = createIpcClient(ipc);
    const received: string[] = [];
    const unsubscribe = client.subscribe('atlas:events', (e) => received.push(e.path));

    sender.send('atlas:events', { reason: 'change', path: 'a.md', index: {} as never });
    unsubscribe();
    sender.send('atlas:events', { reason: 'change', path: 'b.md', index: {} as never });

    expect(received).toEqual(['a.md']);
  });
});
