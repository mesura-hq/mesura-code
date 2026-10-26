import { page, userEvent } from "vite-plus/test/browser";
import { act, type Screen } from "../test/render";
import { flushBrowserTasks } from "./test/browserTasks";
/**
 * Entry point: AppRoot over the shared fence (`test/appRootFenceApp.tsx`),
 * with the real ChatView, its real ThreadDetailsPanel and upstream's real
 * OpenInPicker. The fixture adds two things to the shared one: the primary
 * server reports Zed as installed, and the open thread's environment is the
 * primary environment, which is where upstream shows the picker and arms the
 * favorite-editor shortcut. Every `useAtomCommand` call records the command
 * and its input, so a spec proves whether the open-in-editor RPC ran.
 *
 * Mesura's `openInExternalEditor` client setting (default off) gates both the
 * "Open in <editor>" control and the shortcut; these specs pin the gate.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

const recorded = vi.hoisted(() => ({
  commands: [] as Array<{ command: unknown; value: unknown }>,
}));

// The boundaries the fixture replaces: see `test/appRootFenceMocks.tsx`.
const fenceMocks = vi.hoisted(() => () => import("./test/appRootFenceMocks"));
vi.mock("./state/presentation", async (original) =>
  (await fenceMocks()).mockPresentation(original),
);
vi.mock("./connection/runtime", async () => (await fenceMocks()).mockConnectionRuntime());
vi.mock("./state/entities", async (original) => (await fenceMocks()).mockEntities(original));
vi.mock("./state/environments", async (original) => {
  const mocks = await fenceMocks();
  const environments = await mocks.mockEnvironments(original);
  // The open thread lives on the primary environment, the case upstream offers local editors in.
  return { ...environments, usePrimaryEnvironment: () => mocks.appRootFence.environments[0] };
});
vi.mock("./state/query", async (original) => (await fenceMocks()).mockQuery(original));
vi.mock("./state/queries", async (original) => (await fenceMocks()).mockQueries(original));
vi.mock("./state/threads", async (original) => (await fenceMocks()).mockThreads(original));
vi.mock("./state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (value: unknown) => {
    recorded.commands.push({ command, value });
    return { _tag: "Success", value: { providers: [] } };
  },
}));
vi.mock("./state/use-atom-query-runner", async () => (await fenceMocks()).mockAtomQueryRunner());
vi.mock("./state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await (await fenceMocks()).mockServer(original)),
    primaryServerAvailableEditorsAtom: Atom.make(() => ["zed"] as const),
  };
});
vi.mock("./hooks/useSettings", async (original) => (await fenceMocks()).mockSettings(original));
vi.mock("./hooks/useHandleNewThread", async () => (await fenceMocks()).mockHandleNewThread());
vi.mock("./hooks/useThreadActions", async () => (await fenceMocks()).mockThreadActions());
vi.mock("./components/Sidebar", async () => (await fenceMocks()).mockSidebar());
vi.mock("./components/LegacySidebar", async () =>
  (await fenceMocks()).mockRendersNothing("default"),
);
vi.mock("./components/preview/PreviewAutomationHosts", async () =>
  (await fenceMocks()).mockRendersNothing("PreviewAutomationHosts"),
);
vi.mock("./browser/ElectronBrowserHost", async () =>
  (await fenceMocks()).mockRendersNothing("ElectronBrowserHost"),
);
vi.mock("./components/QuitHoldOverlay", async () =>
  (await fenceMocks()).mockRendersNothing("QuitHoldOverlay"),
);
vi.mock("./components/chat/ChatHeader", async () =>
  (await fenceMocks()).mockRendersNothing("ChatHeader"),
);
vi.mock("./components/BranchToolbar", async () =>
  (await fenceMocks()).mockRendersNothing("BranchToolbar"),
);
vi.mock("./components/files/mesuraFileManager/MesuraFileManagerLayer", async () =>
  (await fenceMocks()).mockFileManagerLayer(),
);
vi.mock("./keys/highlights", async () => (await fenceMocks()).mockHighlights());
vi.mock("@legendapp/list/react", async () => (await fenceMocks()).mockLegendList());
vi.mock("@t3tools/client-runtime/state/session", async (original) =>
  (await fenceMocks()).mockRuntimeSession(original),
);

import { installKeyEngine } from "./keys/keyEngine";
import { shellEnvironment } from "./state/shell";
import {
  addFenceThread,
  fenceEnvironmentId as environmentId,
  makeMessage,
  renderFenceApp,
} from "./test/appRootFenceApp";
import { appRootFence as fixture } from "./test/appRootFenceMocks";

let root: Screen | undefined;
let container: HTMLDivElement;
let threadSequence = 0;

async function setupOpenInFixture({ openInExternalEditor }: { openInExternalEditor?: boolean }) {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 900);
  installKeyEngine();
  recorded.commands.length = 0;
  fixture.vimMode = false;
  fixture.clientSettings = openInExternalEditor === undefined ? {} : { openInExternalEditor };
  container = document.createElement("div");
  document.body.append(container);

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root?.[Symbol.asyncDispose]());
      root = undefined;
      container.remove();
      fixture.threads.clear();
      fixture.threadStates.clear();
      fixture.clientSettings = {};
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

function addThread(): ThreadId {
  threadSequence += 1;
  const id = `open-in-external-editor-${threadSequence}`;
  return addFenceThread(id, "Open in external editor", [
    makeMessage(`${id}-user`, "user", "Where is the config?"),
    makeMessage(`${id}-assistant`, "assistant", "In the project root."),
  ]);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await flushBrowserTasks();
    });
  }
}

async function mountApp() {
  ({ root } = await renderFenceApp(container, addThread(), { vimMode: false }));
  await settle();
}

function threadDetailsPanel() {
  return document.querySelector<HTMLElement>("[data-thread-details-panel]");
}

async function clickThreadDetailsToggle() {
  const toggle = container.querySelector<HTMLElement>('[aria-label="Toggle thread details panel"]');
  expect(toggle, "the thread details toggle is on screen").not.toBeNull();
  await userEvent.click(toggle!);
  await settle();
}

/**
 * At desktop width the details card starts open inline, so the toggle first
 * closes it; the second press is the one that opens it, as a user would.
 */
async function openThreadDetailsPanel() {
  if (threadDetailsPanel() !== null) {
    await clickThreadDetailsToggle();
    await vi.waitFor(() => expect(threadDetailsPanel(), "the card closed").toBeNull());
  }
  await clickThreadDetailsToggle();
  const panel = await vi.waitFor(() => {
    const element = threadDetailsPanel();
    expect(element, "the thread details card is open").not.toBeNull();
    return element!;
  });
  // The picker is withheld at the "essential" density, which would hide it for another reason.
  expect(panel.dataset.density).not.toBe("essential");
}

/** Upstream's picker row: a group labelled "Open in editor" around the preferred editor's button. */
const openInEditorGroup = () => document.querySelector('[aria-label="Open in editor"]');

const openInEditorCalls = () =>
  recorded.commands.filter((entry) => entry.command === shellEnvironment.openInEditor);

/** The shipped favorite-editor chord, `alt+o`, as a real keydown from the focused element. */
async function pressFavoriteEditorChord() {
  const event = new KeyboardEvent("keydown", {
    key: "o",
    code: "KeyO",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
}

describe("AppRoot open in external editor", () => {
  it("hides the Open in editor control in thread details by default", async () => {
    await using _fixture = await setupOpenInFixture({});
    await mountApp();
    await openThreadDetailsPanel();
    expect(openInEditorGroup()).toBeNull();
    expect(document.body.textContent).not.toContain("Open in Zed");
  });

  it("shows the Open in Zed control in thread details when the setting is on", async () => {
    await using _fixture = await setupOpenInFixture({ openInExternalEditor: true });
    await mountApp();
    await openThreadDetailsPanel();
    const group = await vi.waitFor(() => {
      const element = openInEditorGroup();
      expect(element, "the Open in editor row is on screen").not.toBeNull();
      return element!;
    });
    expect(threadDetailsPanel()?.contains(group), "the row is in the details card").toBe(true);
    expect(group.textContent).toContain("Open in Zed");
  });

  it("leaves the favorite-editor chord inert by default", async () => {
    await using _fixture = await setupOpenInFixture({});
    await mountApp();
    await pressFavoriteEditorChord();
    expect(openInEditorCalls()).toEqual([]);
  });

  it("opens the project in Zed from the favorite-editor chord when the setting is on", async () => {
    await using _fixture = await setupOpenInFixture({ openInExternalEditor: true });
    await mountApp();
    await pressFavoriteEditorChord();
    expect(openInEditorCalls()).toEqual([
      {
        command: shellEnvironment.openInEditor,
        value: { environmentId, input: { cwd: fixture.project.workspaceRoot, editor: "zed" } },
      },
    ]);
  });
});
