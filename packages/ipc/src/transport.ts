// Minimal structural interfaces matching the slices of Electron's ipc objects we use. Declared
// here so packages/ipc never imports Electron (constitution rule 2); apps/desktop passes the real
// ipcMain / ipcRenderer / webContents, which are structurally compatible.
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
}

export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

export type IpcRendererListener = (event: unknown, ...args: unknown[]) => void;

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcRendererListener): void;
  removeListener(channel: string, listener: IpcRendererListener): void;
}
