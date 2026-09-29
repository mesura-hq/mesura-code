// @vitest-environment happy-dom
/**
 * Entry point: AppRoot → CommandPalette. A memory router renders the real
 * CommandPalette around the routed outlet; Ctrl+Alt+K, Ctrl+P and Ctrl+O reach
 * the thread picker, the file picker and the command palette through the
 * palette's own keyboard route. The fixture replaces data sources only.
 *
 * Guards for phase 4 criterion 6 of the agent thread search plan: behavior that
 * already works at the base and must keep working once the thread picker gains
 * an agent mode. Every test here passes before the phase starts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  focusIsInPickerTextField,
  mountApp,
  openCommandPalette,
  openFilePicker,
  openThreadSearch,
  optionRows,
  paletteElement,
  paletteMode,
  pickerTextField,
  pressKey,
  threadSearchPicker,
  typeInto,
  type MountedApp,
} from "./threadSearchPicker.testMount";

let app: MountedApp | undefined;

beforeEach(() => {
  resetThreadSearchFixture();
});

afterEach(async () => {
  await app?.unmount();
  app = undefined;
});

function rowTitled(title: string): HTMLElement {
  const row = optionRows().find((candidate) => candidate.textContent?.includes(title));
  expect(
    row,
    `Expected a row titled ${title}; rows: ${optionRows().map((r) => r.textContent)}`,
  ).toBeDefined();
  return row!;
}

describe("thread search guards: shortcut, lexical search, file picker, command palette", () => {
  beforeEach(async () => {
    app = await mountApp();
  });

  it("thread search guard: Ctrl+Alt+K opens the thread picker with focus in its field and a second press closes it", async () => {
    await openThreadSearch();
    expect(paletteMode()).toBe("threads");
    expect(focusIsInPickerTextField()).toBe(true);
    expect(optionRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Rename keybind chord"),
      expect.stringContaining("Hosts dock layout"),
    ]);

    await openThreadSearch();
    expect(paletteElement()).toBeNull();
  });

  it("thread search guard: exact words match in any order and Enter opens the matching thread", async () => {
    await openThreadSearch();
    await typeInto(pickerTextField(), "keybind rename");

    expect(optionRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Rename keybind chord"),
    ]);

    await pressKey(pickerTextField(), "Enter");
    expect(currentPath(app!)).toBe(`/${LAPTOP_ENVIRONMENT_ID}/thread-rename-keybind`);
    expect(paletteElement()).toBeNull();
    expect(threadSearchFixture.agentCalls).toHaveLength(0);
  });

  it("thread search guard: Escape from exact-word thread search goes back to the command palette", async () => {
    await openThreadSearch();
    await pressKey(pickerTextField(), "Escape");
    expect(paletteMode()).toBe("command");
  });

  it("thread search guard: Ctrl+P opens the file picker and Tab there leaves it the file picker", async () => {
    await openFilePicker();
    expect(paletteMode()).toBe("files");
    const fileInput = paletteElement()!.querySelector<HTMLInputElement>("input");
    expect(fileInput, "Expected the file picker's input").not.toBeNull();

    await pressKey(fileInput!, "Tab");
    expect(paletteMode()).toBe("files");
    expect(threadSearchPicker()).toBeNull();
    expect(threadSearchFixture.agentCalls).toHaveLength(0);
  });

  it("thread search guard: the command palette's Search threads row opens exact-word thread search", async () => {
    await openCommandPalette();
    expect(paletteMode()).toBe("command");

    await click(rowTitled("Search threads"));
    expect(paletteMode()).toBe("threads");
    expect(optionRows().map((row) => row.textContent)).toContainEqual(
      expect.stringContaining("Rename keybind chord"),
    );
  });

  it("thread search guard: a command palette thread row still opens its thread", async () => {
    await openCommandPalette();
    await click(rowTitled("Rename keybind chord"));
    expect(currentPath(app!)).toBe(`/${LAPTOP_ENVIRONMENT_ID}/thread-rename-keybind`);
    expect(paletteElement()).toBeNull();
  });
});

describe("thread search guards: archived-thread unarchive semantics", () => {
  it("thread search guard: unarchiveThread dispatches one scoped unarchive and returns its failure unchanged", async () => {
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
