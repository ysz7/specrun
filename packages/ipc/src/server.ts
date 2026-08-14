// Main-side helpers: register a typed handler (request validated by zod at the boundary) and push
// typed events. The only sanctioned way to serve a channel.
import { invokeChannels } from './channels.js';
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
} from './contract.js';
import type { IpcMainLike, WebContentsLike } from './transport.js';

export type InvokeHandler<C extends InvokeChannel> = (
  request: InvokeRequest<C>,
) => InvokeResponse<C> | Promise<InvokeResponse<C>>;

/** Register typed invoke handlers on an ipcMain-like object; requests are zod-validated. */
export function createIpcServer(ipcMain: IpcMainLike): {
  handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void;
} {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (_event, raw) => {
        const request = invokeChannels[channel].request.parse(raw) as InvokeRequest<typeof channel>;
        return handler(request);
      });
    },
  };
}

/** Push typed events to a (possibly not-yet-existing) renderer target. */
export function createEventSender(target: () => WebContentsLike | undefined): {
  send<E extends EventChannel>(channel: E, payload: EventPayload<E>): void;
} {
  return {
    send(channel, payload) {
      target()?.send(channel, payload);
    },
  };
}
