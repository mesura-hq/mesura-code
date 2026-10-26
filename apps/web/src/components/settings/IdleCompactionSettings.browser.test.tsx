import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: {} as UnifiedSettings,
  mixedKeys: [] as string[],
  /** Whether each selected environment's server reads `idleCompactionEnabled`. */
  serversReadSwitch: [] as boolean[],
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: (keys) => keys.some((key) => state.mixedKeys.includes(key)),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    connectedEnvironments: state.serversReadSwitch.map((idleCompactionSwitch) => ({
      serverConfig: { environment: { capabilities: { idleCompactionSwitch } } },
    })),
  })) as never,
}));
// The real row reads write permission and inheritance from live environment
// state; this suite is about which rows show and what they write.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, control, resetAction }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {resetAction}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { IdleCompactionSettings } from "./IdleCompactionSettings";

const content = () => (
  <StrictMode>
    <IdleCompactionSettings />
  </StrictMode>
);

const modeSelect = () => page.getByRole("combobox", { name: "Compact idle threads" });
const idleCompactionSwitch = () => page.getByRole("switch", { name: "Idle compaction" });

async function setup(
  settings: Partial<UnifiedSettings>,
  { mixedKeys = [] as string[], serversReadSwitch = [true] } = {},
) {
  // The developer's homes store the mode the server wrote on its own.
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, idleCompaction: "onReturn", ...settings };
  state.mixedKeys = mixedKeys;
  state.serversReadSwitch = serversReadSwitch;
  const screen = await render(content());
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.settings = { ...state.settings, ...patch } as UnifiedSettings;
    void screen.rerender(content());
  });
  return screen;
}

describe("IdleCompactionSettings", () => {
  it("hides a stored mode until idle compaction is switched on", async () => {
    await using _screen = await setup({});

    await expect.element(idleCompactionSwitch()).not.toBeChecked();
    await expect.element(modeSelect()).not.toBeInTheDocument();

    await userEvent.click(idleCompactionSwitch());

    expect(state.updateSettings).toHaveBeenCalledWith({ idleCompactionEnabled: true });
    await expect.element(idleCompactionSwitch()).toBeChecked();
    await expect.element(modeSelect()).toHaveTextContent("When you return");
  });

  it("hides the mode again when switched off, and resets to off", async () => {
    await using _screen = await setup({ idleCompactionEnabled: true });
    await expect.element(modeSelect()).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Reset idle compaction to default" }));

    expect(state.updateSettings).toHaveBeenCalledWith({ idleCompactionEnabled: false });
    await expect.element(idleCompactionSwitch()).not.toBeChecked();
    await expect.element(modeSelect()).not.toBeInTheDocument();
  });

  it("shows the mode as mixed while environments disagree on the switch", async () => {
    await using _screen = await setup({}, { mixedKeys: ["idleCompactionEnabled"] });
    await expect.element(modeSelect()).toHaveTextContent("Mixed");
  });

  it("shows a server from before the switch the mode it still compacts by", async () => {
    await using _screen = await setup(
      { idleCompaction: "beforeCacheExpires" },
      { serversReadSwitch: [false] },
    );
    await expect.element(idleCompactionSwitch()).not.toBeInTheDocument();
    await expect.element(modeSelect()).toHaveTextContent("Before the cache expires (beta)");
  });

  it("offers neither control while the selection mixes old and new servers", async () => {
    await using _screen = await setup({}, { serversReadSwitch: [true, false] });
    await expect.element(page.getByText(/run a server from before this switch/)).toBeVisible();
    await expect.element(idleCompactionSwitch()).not.toBeInTheDocument();
    await expect.element(modeSelect()).not.toBeInTheDocument();
  });
});
