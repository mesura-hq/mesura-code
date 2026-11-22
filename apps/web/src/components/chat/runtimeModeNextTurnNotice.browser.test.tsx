import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: mocks.toast } as never };
});

import { render } from "../../../test/render";
import { useComposerSelection } from "./useComposerSelection";

function setup() {
  mocks.toast.mockReset();
}

const environmentId = EnvironmentId.make("environment-local");
type Runtime = Parameters<typeof useComposerSelection>[0]["activeRuntime"];
const runningTurn = { activeRunId: "run-1" } as Runtime;

function PermissionsPicker(props: {
  threadId: string;
  savedMode: RuntimeMode;
  shownMode: RuntimeMode;
  runtime: Runtime;
  isLocalDraftThread?: boolean;
}) {
  const thread = {
    environmentId,
    id: ThreadId.make(props.threadId),
    runtimeMode: props.savedMode,
  } as EnvironmentThreadShell;
  const { handleRuntimeModeChangeStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: scopeThreadRef(environmentId, thread.id),
    draftThread: null,
    activeThread: thread,
    activeRuntime: props.runtime,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: [],
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: props.shownMode,
    isLocalDraftThread: props.isLocalDraftThread ?? false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <>
      <button type="button" onClick={() => handleRuntimeModeChangeStable("full-access")}>
        Full access
      </button>
      <button type="button" onClick={() => handleRuntimeModeChangeStable("approval-required")}>
        Supervised
      </button>
    </>
  );
}

it("tells the user a pick made during a turn starts with the next turn", async () => {
  setup();
  await using _screen = await render(
    <PermissionsPicker
      threadId="thread-running"
      savedMode="approval-required"
      shownMode="approval-required"
      runtime={runningTurn}
    />,
  );
  await page.getByRole("button", { name: "Full access" }).click();

  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Full access starts with the next turn" }),
    ),
  );
});

it("stays quiet when the pick returns to the saved mode during a turn", async () => {
  setup();
  await using _screen = await render(
    <PermissionsPicker
      threadId="thread-running-back"
      savedMode="approval-required"
      shownMode="full-access"
      runtime={runningTurn}
    />,
  );
  await page.getByRole("button", { name: "Supervised" }).click();

  expect(mocks.toast).not.toHaveBeenCalled();
});

it("stays quiet without a running turn and on a local draft", async () => {
  setup();
  {
    await using _idle = await render(
      <PermissionsPicker
        threadId="thread-idle"
        savedMode="approval-required"
        shownMode="approval-required"
        runtime={null}
      />,
    );
    await page.getByRole("button", { name: "Full access" }).click();
  }
  {
    await using _draft = await render(
      <PermissionsPicker
        threadId="thread-draft"
        savedMode="approval-required"
        shownMode="approval-required"
        runtime={runningTurn}
        isLocalDraftThread
      />,
    );
    await page.getByRole("button", { name: "Full access" }).click();
  }
  expect(mocks.toast).not.toHaveBeenCalled();
});
