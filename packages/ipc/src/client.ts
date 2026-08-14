// Renderer/preload-side helper: a typed wrapper over ipcRenderer. Lives in preload (which has
// ipcRenderer); the renderer itself talks only to the exposed AlethicApi.
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
} from './contract.js';
import type { IpcRendererLike, IpcRendererListener } from './transport.js';

export interface IpcClient {
  invoke<C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>,
  ): Promise<InvokeResponse<C>>;
  subscribe<E extends EventChannel>(
    channel: E,
    callback: (payload: EventPayload<E>) => void,
  ): () => void;
}

export function createIpcClient(ipcRenderer: IpcRendererLike): IpcClient {
  return {
    invoke(channel, request) {
      return ipcRenderer.invoke(channel, request) as Promise<InvokeResponse<typeof channel>>;
    },
    subscribe(channel, callback) {
      const listener: IpcRendererListener = (_event, payload) =>
        callback(payload as EventPayload<typeof channel>);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  };
}
