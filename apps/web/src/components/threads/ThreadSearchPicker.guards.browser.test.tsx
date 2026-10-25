/**
 * Entry point: AppRoot → CommandPalette. A memory router renders the real
 * CommandPalette around the routed outlet; Ctrl+P and Ctrl+O reach the file
 * picker and the command palette through the palette's own keyboard route. The
 * fixture replaces data sources only.
 *
 * Guards first written for phase 4 criterion 6 of the agent thread search plan.
 * The search unification cycle removed the picker's exact-word mode, and with
 * it the guards that pinned Ctrl+Alt+K, exact words and the Search threads row
 * opening it: those now land in the sidebar Search
 * (`AppRoot.searchUnification.fence.browser.test.tsx`).
 */
import { describe, expect, it, vi } from "vite-plus/test";

// Keep session grant checks real; the shared fixture supplies authenticated sessions.
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await import("../../test/appRootFenceMocks")).mockRuntimeSession(original),
);
// Keep ranking assertions independent of the virtualized list's viewport.
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

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";

import {
  commandFailure,
  LAPTOP_ENVIRONMENT_ID,
  resetThreadSearchFixture,
  threadSearchFixture,
  UNARCHIVE_COMMAND_LABEL,
} from "./threadSearchPicker.testFixtures";
import {
  click,
  currentPath,
  mountApp,
  openCommandPalette,
  openFilePicker,
  optionRows,
  paletteElement,
  paletteMode,
  pressKey,
  threadSearchPicker,
  type MountedApp,
} from "./threadSearchPicker.testMount";

let app: MountedApp | undefined;

async function setupBrowserFixture0() {
  resetThreadSearchFixture();

  return {
    async [Symbol.asyncDispose]() {
      await app?.unmount();
      app = undefined;
    },
  };
}

function rowTitled(title: string): HTMLElement {
  const row = optionRows().find((candidate) => candidate.textContent?.includes(title));
  expect(
    row,
    `Expected a row titled ${title}; rows: ${optionRows().map((r) => r.textContent)}`,
  ).toBeDefined();
  return row!;
}

describe("thread search guards: file picker and command palette", () => {
  async function setupBrowserFixture1() {
    app = await mountApp();

    return { async [Symbol.asyncDispose]() {} };
  }

  it("thread search guard: Ctrl+P opens the file picker and Tab there leaves it the file picker", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await openFilePicker();
    expect(paletteMode()).toBe("files");
    const fileInput = paletteElement()!.querySelector<HTMLInputElement>("input");
    expect(fileInput, "Expected the file picker's input").not.toBeNull();

    await pressKey(fileInput!, "Tab");
    expect(paletteMode()).toBe("files");
    expect(threadSearchPicker()).toBeNull();
    expect(threadSearchFixture.agentCalls).toHaveLength(0);
  });

  it("thread search guard: a command palette thread row still opens its thread", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();
    await using _browserFixture1 = await setupBrowserFixture1();

    await openCommandPalette();
    await click(rowTitled("Rename keybind chord"));
    expect(currentPath(app!)).toBe(`/${LAPTOP_ENVIRONMENT_ID}/thread-rename-keybind`);
    expect(paletteElement()).toBeNull();
  });
});

describe("thread search guards: archived-thread unarchive semantics", () => {
  it("thread search guard: unarchiveThread dispatches one scoped unarchive and returns its failure unchanged", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    let actions: ReturnType<typeof useThreadActions> | null = null;
    function ThreadActionsProbe() {
      const threadActions = useThreadActions();
      useEffect(() => {
        actions = threadActions;
      }, [threadActions]);
      return null;
    }
    app = await mountApp({ homeRoute: ThreadActionsProbe });
    expect(actions).not.toBeNull();

    threadSearchFixture.commandReplies.set(UNARCHIVE_COMMAND_LABEL, async () =>
      commandFailure("Thread is locked by another client"),
    );
    const threadId = ThreadId.make("thread-archived-guard");
    const result = await actions!.unarchiveThread(scopeThreadRef(LAPTOP_ENVIRONMENT_ID, threadId));

    expect(threadSearchFixture.commandCalls).toEqual([
      {
        label: UNARCHIVE_COMMAND_LABEL,
        value: { environmentId: LAPTOP_ENVIRONMENT_ID, input: { threadId } },
      },
    ]);
    expect(result._tag).toBe("Failure");
  });
});
