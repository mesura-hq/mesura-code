import type { IpcReply } from "@symmetria/fm-core/contract";
import type { IpcHandler, IpcSurface, SenderHandle } from "@symmetria/fm-main/ipc/register";
import {
  type FileManagerEvent,
  type FileManagerPushChannel,
  toFileManagerWireValue,
} from "@t3tools/contracts";

/**
 * The file manager's `IpcSurface` over the WebSocket. The `SenderHandle` is a session, opened
 * only by a client's event stream. Sessions are keyed by owner (the RPC client id) and session
 * id, so a device never reaches another's session. A request for an unopened session is refused:
 * a watch registered without a sink would leak until the registry is disposed.
 */

/** Where a session's pushes go: the queue behind its event stream. */
export type SessionSink = (event: FileManagerEvent) => void;

/** The connection a session belongs to, and the client's name for it. */
export interface SessionKey {
  readonly owner: string;
  readonly sessionId: string;
}

export interface WsIpcTransport {
  readonly surface: IpcSurface;
  /** Open a session, or `null` when that owner already has one by that id. */
  openSession(key: SessionKey, sink: SessionSink): SenderHandle | null;
  /** Close a session and hand back its handle for the registry to release, or `null`. */
  closeSession(key: SessionKey): SenderHandle | null;
  /** Run a channel's handler for a session. Never throws: every outcome is a reply. */
  invoke(key: SessionKey, channel: string, payload: unknown): Promise<IpcReply>;
}

function refused(message: string): IpcReply {
  return { ok: false, error: { code: "invalid_request", message } };
}

/**
 * Handlers answer as for Electron's IPC, bytes and `undefined` included, but the WebSocket
 * carries JSON. A reply JSON cannot write dies in the RPC encoder as a defect (`describe`'s byte
 * head did), so every value crosses through the contract's wire codec.
 */
function wireReply(reply: IpcReply): IpcReply {
  if (!reply.ok) return reply;
  const value = toFileManagerWireValue(reply.value);
  // SAFETY: the codec changes only what JSON cannot carry; the reply keeps its shape.
  return value === reply.value ? reply : ({ ok: true, value } as IpcReply);
}

/**
 * The owner and the id, joined on a NUL, a byte neither can hold: the owner
 * is the server's RPC client id and the session id is a trimmed string the
 * contract caps at 64 characters. Written as an escape so the file stays
 * text to git.
 */
function mapKey({ owner, sessionId }: SessionKey): string {
  return `${owner}\0${sessionId}`;
}

export function createWsIpcSurface(): WsIpcTransport {
  const handlers = new Map<string, IpcHandler>();
  const sessions = new Map<string, SenderHandle>();

  const surface: IpcSurface = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };

  return {
    surface,
    openSession(key, sink) {
      const id = mapKey(key);
      if (sessions.has(id)) return null;
      const handle: SenderHandle = {
        send(channel, payload) {
          // The registry only ever pushes on its own push channels; the cast
          // names that fact for the contract's literal type.
          sink({
            channel: channel as FileManagerPushChannel,
            payload: toFileManagerWireValue(payload),
          });
        },
      };
      sessions.set(id, handle);
      return handle;
    },
    closeSession(key) {
      const id = mapKey(key);
      const handle = sessions.get(id) ?? null;
      sessions.delete(id);
      return handle;
    },
    async invoke(key, channel, payload) {
      const handle = sessions.get(mapKey(key));
      if (handle === undefined) return refused("session not open");
      const handler = handlers.get(channel);
      if (handler === undefined) return refused("unknown channel");
      try {
        return wireReply(await handler(payload, handle));
      } catch (cause) {
        // Catches a handler registered without the registry's guard. `invalid_reply` means "the
        // host failed to answer": `invalid_request` would blame input that was never wrong.
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: { code: "invalid_reply", message: `${channel}: ${message}` } };
      }
    },
  };
}
