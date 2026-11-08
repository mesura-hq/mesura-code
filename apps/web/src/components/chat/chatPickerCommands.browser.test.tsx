import { useRef, useState, type ReactNode } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { render } from "../../../test/render";
import { useCommandHandlers, runRegisteredCommand } from "../../commands/commandRegistry";
import { subscribePickerAction } from "../../lib/pickerActionBus";
import { chatPickerCommands } from "./chatPickerCommands";
import { useChatShortcuts } from "./useChatShortcuts";

// The controller reads labels from the server atom. Keep this fixture offline.
vi.mock("../../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS: keybindings } = await import("@t3tools/shared/keybindings");
  return {
    ...(await original<typeof import("../../state/server")>()),
    primaryServerKeybindingsAtom: Atom.make(keybindings),
  };
});

import { useRunContextController } from "../runContext/useRunContextController";
import { RunContextDrawer } from "../runContext/RunContextDrawer";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";

function ChatPickerHost({ children }: { children?: ReactNode }) {
  useCommandHandlers(chatPickerCommands);
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: useRef(null),
    branchToolbarRef: useRef(null),
    closeThreadFind: () => {},
    commands: chatPickerCommands,
    fallback: () => undefined,
  });
  return (
    <>
      <button>Chat focus</button>
      {children}
    </>
  );
}

it("reaches all three run context actions through chords and the Vim command registry", async () => {
  // router: false because this probe drives shortcut dispatch without navigation.
  await using screen = await render(<ChatPickerHost />, { router: false });
  const toggle = vi.fn();
  const cycleMachine = vi.fn();
  const toggleWorkspace = vi.fn();
  using subscriptions = new DisposableStack();
  subscriptions.defer(subscribePickerAction("runContext.toggle", toggle));
  subscriptions.defer(subscribePickerAction("runContext.cycleMachine", cycleMachine));
  subscriptions.defer(subscribePickerAction("runContext.toggleWorkspace", toggleWorkspace));
  await screen.getByRole("button", { name: "Chat focus" }).click();
  await userEvent.keyboard("{Alt>}w{/Alt}");
  await userEvent.keyboard("{Control>}{Shift>}h{/Shift}{/Control}");
  await userEvent.keyboard("{Alt>}{Shift>}w{/Shift}{/Alt}");
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(cycleMachine).toHaveBeenCalledTimes(1);
  expect(toggleWorkspace).toHaveBeenCalledTimes(1);
  expect(runRegisteredCommand("runContext.toggle")).toBe(true);
  expect(runRegisteredCommand("runContext.cycleMachine")).toBe(true);
  expect(runRegisteredCommand("runContext.toggleWorkspace")).toBe(true);
  expect(toggle).toHaveBeenCalledTimes(2);
  expect(cycleMachine).toHaveBeenCalledTimes(2);
  expect(toggleWorkspace).toHaveBeenCalledTimes(2);
  // Holding a toggle must not undo it on repeated keydown events.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", altKey: true, repeat: true }));
  expect(toggle).toHaveBeenCalledTimes(2);
});

it("preserves held-key repeats for the existing picker shortcuts", async () => {
  // router: false because this probe drives shortcut dispatch without navigation.
  await using screen = await render(<ChatPickerHost />, { router: false });
  const traits = vi.fn();
  using subscriptions = new DisposableStack();
  subscriptions.defer(subscribePickerAction("traits", traits));
  await screen.getByRole("button", { name: "Chat focus" }).click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", altKey: true, repeat: true }));
  expect(traits).toHaveBeenCalledTimes(1);
});

const hosts: EnvironmentOption[] = [
  {
    environmentId: EnvironmentId.make("arch-probe"),
    projectId: null,
    label: "Arch probe",
    isPrimary: true,
    machine: "laptop",
  },
  {
    environmentId: EnvironmentId.make("vigilia-probe"),
    projectId: null,
    label: "Vigilia probe",
    isPrimary: false,
    machine: "server",
  },
];

function RunContextProbe() {
  const [environmentId, setEnvironmentId] = useState(hosts[0]!.environmentId);
  const [mode, setMode] = useState<EnvMode>("local");
  const controller = useRunContextController({
    environmentId,
    availableEnvironments: hosts,
    envLocked: false,
    isDraft: true,
    envModeLocked: false,
    showGitControls: true,
    autoEnvironmentLabel: undefined,
    onEnvironmentChange: setEnvironmentId,
    effectiveEnvMode: mode,
    activeWorktreePath: null,
    onEnvModeChange: setMode,
    onComposerFocusRequest: undefined,
  });
  return (
    <>
      <button onClick={() => runRegisteredCommand("runContext.cycleMachine")}>
        Cycle host command
      </button>
      <button onClick={() => runRegisteredCommand("runContext.toggleWorkspace")}>
        Toggle workspace command
      </button>
      <button onClick={() => runRegisteredCommand("runContext.toggle")}>
        Toggle drawer command
      </button>
      <output aria-label="Selected host">{environmentId}</output>
      <output aria-label="Selected workspace">{mode}</output>
      {controller.drawerOpen && (
        <RunContextDrawer {...controller.drawerProps} branchLabel="dev" branchPanel={null} />
      )}
    </>
  );
}

it("changes the real run context through chords and registry commands with two hosts", async () => {
  // router: false because host and workspace selection remain local draft state in this probe.
  await using screen = await render(
    <ChatPickerHost>
      <RunContextProbe />
    </ChatPickerHost>,
    { router: false },
  );
  await screen.getByRole("button", { name: "Chat focus" }).click();
  await userEvent.keyboard("{Control>}{Shift>}h{/Shift}{/Control}");
  await expect
    .element(screen.getByRole("status", { name: "Selected host" }))
    .toHaveTextContent("vigilia-probe");
  await screen.getByRole("button", { name: "Cycle host command" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Selected host" }))
    .toHaveTextContent("arch-probe");
  await userEvent.keyboard("{Alt>}{Shift>}w{/Shift}{/Alt}");
  await expect
    .element(screen.getByRole("status", { name: "Selected workspace" }))
    .toHaveTextContent("worktree");
  await screen.getByRole("button", { name: "Toggle workspace command" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Selected workspace" }))
    .toHaveTextContent("local");
  await userEvent.keyboard("{Alt>}w{/Alt}");
  await expect
    .element(screen.getByRole("group", { name: "Run context", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Toggle drawer command" }).click();
  await expect
    .element(screen.getByRole("group", { name: "Run context", exact: true }))
    .not.toBeInTheDocument();
});
