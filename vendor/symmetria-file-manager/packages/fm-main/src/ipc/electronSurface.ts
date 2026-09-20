import type { IpcReply } from "@symmetria/fm-core/contract";
import type { IpcMainInvokeEvent } from "electron";

import type { IpcSurface, SenderHandle } from "./register.ts";

/**
 * Adapt Electron's `ipcMain` to the transport shape the registry expects.
 *
 * This adapter exists because of a real defect. `ipcMain.handle` invokes its
 * handler with `(event, ...args)` — two arguments — while the registry's
 * `IpcSurface` declares one. Wired directly, every handler received the EVENT
 * where it expected the request, and the decoder rejected all of it as
 * `invalid_request`.
 *
 * The unit tests did not catch it: their fake transport calls
 * `handler(payload)` with one argument, so it encoded the assumption rather
 * than the API. The end-to-end smoke test through a real renderer is what
 * found it. Keeping the mismatch in one named adapter is what stops the same
 * assumption leaking back into the registry.
 */
/**
 * Exactly the two members this adapter touches, DESCRIBED rather than picked.
 *
 * Narrower than `IpcMain` on purpose. Asking for the whole interface forced a
 * test double through `as unknown as IpcMain` — an assertion chain that throws
 * away the type evidence the double actually has, and one the anti-slop gate
 * rejects outright.
 *
 * `Pick<IpcMain, ...>` was the first attempt and is not narrow enough, for a
 * reason worth stating because it is not obvious: picking `handle` also picks
 * its LISTENER type, so a double had to accept a listener taking a whole
 * `IpcMainInvokeEvent` — pushing the assertion one level down instead of
 * removing it. Describing the requirement puts the narrowing where it belongs.
 *
 * Nothing here is unchecked. The real `ipcMain` is passed to this function in
 * `app/src/main/index.ts`, so `tsc -p app/tsconfig.main.json` is what proves the
 * description still matches Electron's API.
 */
export interface IpcMainHandlers {
  // The listener answers with `IpcReply` and not `unknown`: it is the registry's
  // handler, and every channel's reply is already a closed union. Electron's own
  // signature returns `any`, so anything narrower satisfies it.
  handle(
    channel: string,
    listener: (event: InvokeEvent, payload: unknown) => Promise<IpcReply>,
  ): void;
  removeHandler(channel: string): void;
}

/**
 * Exactly what this adapter does with a renderer, and nothing more.
 *
 * Narrow for the same reason `IpcMainHandlers` is narrow: a test double
 * satisfies it structurally, with no assertion chain to throw away the type
 * evidence it already has.
 */
type Renderer = Pick<IpcMainInvokeEvent["sender"], "isDestroyed" | "send">;

/** The one member of the invoke event this adapter reads. */
export interface InvokeEvent {
  readonly sender: Renderer;
}

/**
 * The surface, plus a way to name a window the registry has not heard from.
 *
 * `handleFor` exists for one caller: the host, telling the registry to release
 * a window it is about to destroy. Every other handle reaches the registry on
 * its own, riding the request that produced it.
 */
export interface ElectronTransport {
  readonly surface: IpcSurface;
  /** The stable handle for this renderer, minted once and reused. */
  handleFor(renderer: Renderer): SenderHandle;
}

export function electronIpcSurface(ipcMain: IpcMainHandlers): ElectronTransport {
  /**
   * One handle per renderer, and the same one every time.
   *
   * Stability is not a nicety here — the registry uses the handle as a map key,
   * so a fresh object per request would file every request under a new window
   * and never find anything again.
   *
   * Weak, so a destroyed renderer's handle goes away with it rather than being
   * pinned for the life of a resident daemon that opens a window per dialog.
   */
  const handles = new WeakMap<Renderer, SenderHandle>();

  function handleFor(renderer: Renderer): SenderHandle {
    const existing = handles.get(renderer);
    if (existing !== undefined) return existing;

    const fresh: SenderHandle = {
      send(channel, payload) {
        // A destroyed window is dropped rather than thrown at: a push racing a
        // close is ordinary, and Electron throws on a destroyed `WebContents`.
        if (!renderer.isDestroyed()) renderer.send(channel, payload);
      },
    };
    handles.set(renderer, fresh);
    return fresh;
  }

  return {
    surface: {
      handle(channel, handler) {
        // The event is no longer dropped: its `sender` is the whole reason more
        // than one window can be served. The payload still arrives second,
        // which is the mismatch this adapter was written for.
        ipcMain.handle(channel, (event: InvokeEvent, payload: unknown) =>
          handler(payload, handleFor(event.sender)),
        );
      },
      removeHandler(channel) {
        ipcMain.removeHandler(channel);
      },
    },
    handleFor,
  };
}
