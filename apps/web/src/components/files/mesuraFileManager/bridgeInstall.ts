import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";

/** Where the file manager's UI looks for its host: one global, one name. */
export type BridgeHost = Partial<Record<typeof BRIDGE_KEY, Bridge>>;

/**
 * Put a bridge where the file manager's UI reads it, until the returned function runs.
 * Installing twice throws: every `fm-ui` call goes through `window.symmetriaFm`, so a
 * second bridge would silently route the first layer's watches and transfers elsewhere.
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
