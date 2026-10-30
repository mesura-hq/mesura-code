// @effect-diagnostics nodeBuiltinImport:off -- Hyprland's event socket is a native compositor boundary, as `hyprctl` is.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { isHyprlandSession } from "./hyprctl.ts";

/**
 * A config reload drops every runtime `hyprctl keyword`. Hyprland reloads on its own when a
 * config file is saved, so a running app has to re-send its rules after each reload.
 */
const CONFIG_RELOADED_EVENT = "configreloaded";

/** Hyprland 0.40+ event socket, or `null` outside Hyprland or without a runtime directory. */
export function hyprlandEventSocketPath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (!isHyprlandSession(env) || !runtimeDir) return null;
  return NodePath.join(
    runtimeDir,
    "hypr",
    env.HYPRLAND_INSTANCE_SIGNATURE!.trim(),
    ".socket2.sock",
  );
}

/**
 * Calls `onReload` after each Hyprland config reload until the returned stop runs. The socket
 * sends one `event>>data` line per event, and a chunk can end in the middle of a line.
 */
export function watchHyprlandConfigReloads(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly onReload: () => void;
  readonly onError?: (cause: unknown) => void;
}): () => void {
  const socketPath = hyprlandEventSocketPath(input.env);
  if (socketPath === null) return () => {};
  let partialLine = "";
  const socket = NodeNet.createConnection(socketPath);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const lines = (partialLine + chunk).split("\n");
    partialLine = lines.pop() ?? "";
    if (lines.some((line) => line.split(">>", 1)[0] === CONFIG_RELOADED_EVENT)) input.onReload();
  });
  socket.on("error", (cause) => input.onError?.(cause));
  return () => socket.destroy();
}
