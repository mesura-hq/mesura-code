// @effect-diagnostics nodeBuiltinImport:off - these specs play Hyprland's event socket, which is
// the only way to observe what the watcher reads from it.
/**
 * Entry point: `watchHyprlandConfigReloads`. Hyprland's event socket is a real `node:net` server
 * in a temporary `XDG_RUNTIME_DIR`; it writes `event>>data` lines, as Hyprland 0.56.2 does.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { hyprlandEventSocketPath, watchHyprlandConfigReloads } from "./hyprlandConfigReloads.ts";

const SIGNATURE = "reload_1792696316_1571868373";

async function fakeHyprland() {
  const runtimeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-hypr-"));
  const env = { XDG_RUNTIME_DIR: runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: SIGNATURE };
  const socketPath = hyprlandEventSocketPath(env)!;
  NodeFS.mkdirSync(NodePath.dirname(socketPath), { recursive: true });
  const { promise: connected, resolve: onConnection } = Promise.withResolvers<NodeNet.Socket>();
  const server = NodeNet.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    env,
    connected,
    [Symbol.asyncDispose]: async () => {
      (await Promise.race([connected, Promise.resolve(null)]))?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

describe("watchHyprlandConfigReloads", () => {
  it("calls onReload for a configreloaded line split across chunks, and not for other events", async () => {
    await using hyprland = await fakeHyprland();
    const { promise: reloaded, resolve } = Promise.withResolvers<void>();
    const onReload = vi.fn(resolve);
    const stop = watchHyprlandConfigReloads({ env: hyprland.env, onReload });
    try {
      const socket = await hyprland.connected;
      socket.write(
        "activewindow>>kitty,shell\nopenwindow>>5a,1,mesura-code,configreloaded\nconfig",
      );
      socket.write("reloaded>>\n");
      await reloaded;
      expect(onReload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it("does nothing outside Hyprland", () => {
    expect(hyprlandEventSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBeNull();
    const stop = watchHyprlandConfigReloads({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      onReload: () => {},
    });
    expect(stop).not.toThrow();
  });

  it("reports a socket that is not there", async () => {
    const runtimeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-hypr-"));
    try {
      const { promise: failed, resolve } = Promise.withResolvers<unknown>();
      const stop = watchHyprlandConfigReloads({
        env: { XDG_RUNTIME_DIR: runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: SIGNATURE },
        onReload: () => {},
        onError: resolve,
      });
      expect(await failed).toMatchObject({ code: "ENOENT" });
      stop();
    } finally {
      NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
