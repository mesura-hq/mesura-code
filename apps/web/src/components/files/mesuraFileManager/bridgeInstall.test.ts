import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import { describe, expect, it } from "vite-plus/test";

import { installFileManagerBridge } from "./bridgeInstall";

const fakeBridge = () => ({ version: "test" }) as unknown as Bridge;

describe("installing the bridge on the window", () => {
  it("sets the file manager's global while installed and removes it after", () => {
    const target: Partial<Record<typeof BRIDGE_KEY, Bridge>> = {};
    const bridge = fakeBridge();

    const remove = installFileManagerBridge(bridge, target);
    expect(target[BRIDGE_KEY]).toBe(bridge);

    remove();
    expect(BRIDGE_KEY in target).toBe(false);
  });

  it("refuses a second install while one is present: two layers must never share a session", () => {
    const target: Partial<Record<typeof BRIDGE_KEY, Bridge>> = {};
    const remove = installFileManagerBridge(fakeBridge(), target);

    expect(() => installFileManagerBridge(fakeBridge(), target)).toThrow(/already installed/);

    remove();
    expect(() => installFileManagerBridge(fakeBridge(), target)).not.toThrow();
  });
});
