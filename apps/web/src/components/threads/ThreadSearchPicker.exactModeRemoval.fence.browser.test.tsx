/**
 * Entry point: AppRoot → CommandPalette, through `threadSearchPicker.testMount.tsx`:
 * a memory router renders the real CommandPalette around the routed outlet, and
 * the palette is opened with Ctrl+O as a user opens it. The fixture replaces
 * data sources only, as in `ThreadSearchPicker.agentMode.browser.test.tsx`.
 *
 * Phase 1 of the search unification cycle, criterion 8: the picker's exact mode
 * is gone, and its Agent search stays reachable until phase 3 replaces it. The
 * thread-search command now focuses the sidebar Search, so the Agent search is
 * reached from its own palette row, "Search threads with an agent".
 */
import { describe, expect, it, vi } from "vite-plus/test";

// Keep session grant checks real; the shared fixture supplies authenticated sessions.
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(original),
);
vi.mock("@legendapp/list/react", async () =>
  (await import("../../test/appRootFenceMocks")).mockLegendList(),
);
vi.mock("~/state/server", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockServer(original),
);
vi.mock("~/state/entities", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockEntities(await original()),
);
vi.mock("~/state/environments", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockEnvironments(await original()),
);
vi.mock("~/state/queries", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockQueries(await original()),
);
vi.mock("~/state/orchestration", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockOrchestration(await original()),
);
vi.mock("~/state/use-atom-command", async () =>
  (await import("./threadSearchPicker.testFixtures")).mockUseAtomCommand(),
);
vi.mock("~/hooks/useSettings", async (original) =>
  (await import("./threadSearchPicker.testFixtures")).mockSettings(await original()),
);

import { resetThreadSearchFixture, threadSearchFixture } from "./threadSearchPicker.testFixtures";
import {
  AGENT_FIELD_NAME,
  EXACT_MODE_NAME,
  modeControl,
  mountApp,
  paletteMode,
  pickerTextField,
  pressKey,
  submitDescription,
  toggleAgentSearch,
  type MountedApp,
} from "./threadSearchPicker.testMount";

let app: MountedApp | undefined;

async function setupBrowserFixture0() {
  resetThreadSearchFixture();
  app = await mountApp();

  return {
    async [Symbol.asyncDispose]() {
      await app?.unmount();
      app = undefined;
      vi.restoreAllMocks();
    },
  };
}

async function openAgentSearchFromPalette(): Promise<void> {
  expect(paletteMode()).toBeNull();
  await toggleAgentSearch();
}

describe("search unification: the picker keeps only its Agent search", () => {
  it("picker exact mode spec: the palette's agent row opens the Agent search with its field focused", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    await openAgentSearchFromPalette();

    expect(paletteMode()).toBe("threads");
    const field = pickerTextField();
    expect(field.getAttribute("aria-label")).toBe(AGENT_FIELD_NAME);
    // The palette's content takes focus in a frame after it mounts
    // (`CommandPaletteContent`), so wait for the focus to land.
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("picker exact mode spec: the Agent search offers no Exact mode, and Tab does not switch to one", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await openAgentSearchFromPalette();

    expect(modeControl(EXACT_MODE_NAME), "no Exact segment").toBeNull();
    await pressKey(pickerTextField(), "Tab");

    expect(paletteMode()).toBe("threads");
    expect(pickerTextField().getAttribute("aria-label")).toBe(AGENT_FIELD_NAME);
    expect(modeControl(EXACT_MODE_NAME)).toBeNull();
  });

  it("picker exact mode spec: a description submitted there starts one agent search", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await openAgentSearchFromPalette();

    await submitDescription("the chat where the file tree lagged");

    expect(threadSearchFixture.agentCalls).toHaveLength(1);
  });
});
