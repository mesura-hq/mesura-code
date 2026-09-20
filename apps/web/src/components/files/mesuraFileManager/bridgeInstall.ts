import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";

/** Where the file manager's UI looks for its host: one global, one name. */
export type BridgeHost = Partial<Record<typeof BRIDGE_KEY, Bridge>>;

/**
 * Put a bridge where the file manager's UI reads it, for as long as the
 * returned function has not been called.
 *
 * Exactly one at a time: every `fm-ui` call goes through `window.symmetriaFm`,
 * so a second layer installing over the first would silently route the first
 * layer's watches and transfers to another session. Installing twice throws
 * rather than swapping.
 */
export function installFileManagerBridge(
  bridge: Bridge,
  host: BridgeHost = window as unknown as BridgeHost,
): () => void {
  if (host[BRIDGE_KEY] !== undefined) {
    throw new Error("a file manager bridge is already installed on this page");
  }
  host[BRIDGE_KEY] = bridge;
  return () => {
    if (host[BRIDGE_KEY] === bridge) delete host[BRIDGE_KEY];
  };
}
