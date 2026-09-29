// @vitest-environment happy-dom
/**
 * Phase 8 fence, acceptance criterion 5 on Android: the default thread list
 * row shows a run's label beside branch · machine, and other rows are
 * unchanged.
 *
 * Entry point: `ThreadListV2Row`, the row Home and the navigation sidebar
 * render for each `EnvironmentThreadShell` they receive from the shell stream;
 * the row reads the run's label from that shell's `factoryRun`. Native
 * controls, icons and menus are stubbed to plain elements. The emulator alone
 * shows the label's hue and its truncation on a narrow phone.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryRunShellSummary,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

vi.mock("react-native", () => ({
  Platform: { OS: "android", select: (values: Record<string, unknown>) => values.android },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  Alert: { alert: vi.fn() },
  useWindowDimensions: () => ({ height: 800, width: 390, fontScale: 1, scale: 1 }),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../components/RowPressable", () => ({
  RowPressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ materialYouStyleLayoutActive: false, themeVariables: {} }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("../../state/thread-order", () => ({ threadArrangementOpenAtom: {} }));
vi.mock("../../state/use-thread-pr", () => ({ useThreadPr: () => null }));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: ({ children }: { children: (close: () => void) => ReactNode }) => (
    <div>{children(() => undefined)}</div>
  ),
}));
vi.mock("./thread-title-regeneration-menu", () => ({
  buildThreadTitleRegenerationMenuItems: () => [],
}));
vi.mock("./queued-message-icon", () => ({ QueuedMessageIcon: () => null }));
vi.mock("./thread-search-match", () => ({ ThreadSearchMatchExcerpt: () => null }));

import { ThreadListV2Row } from "./thread-list-v2-items";

const noop = () => undefined;

function makeShell(factoryRun?: FactoryRunShellSummary | null): EnvironmentThreadShell {
  return {
    id: ThreadId.make("factory-run-row"),
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    title: "Invoice CSV export",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "sf-team/invoice-csv-export",
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-28T08:58:00.000Z",
    updatedAt: "2026-09-28T10:18:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...(factoryRun === undefined ? {} : { factoryRun }),
  } as EnvironmentThreadShell;
}

let root: Root;
let container: HTMLDivElement;

async function renderRow(thread: EnvironmentThreadShell) {
  await act(async () =>
    root.render(
      <ThreadListV2Row
        thread={thread}
        variant="card"
        snoozePresetMinute="2026-09-28T10:18"
        project={null}
        projectTitle="Billing web"
        providerInstance={null}
        environmentLabel="vigilia-home"
        onSelectThread={noop}
        onDeleteThread={noop}
        onNewThreadOnBranch={noop}
        onRenameThread={noop}
        onRegenerateThreadTitle={noop}
        onSettleThread={async () => true}
        onSnoozeThread={noop}
        onUnsnoozeThread={noop}
        onUnsettleThread={noop}
        onArchiveThread={noop}
        onPinThread={noop}
        onUnpinThread={noop}
        settlementSupported
        snoozeSupported
        pinningSupported
        titleRegenerationSupported
        onSwipeableWillOpen={noop}
        onSwipeableClose={noop}
      />,
    ),
  );
  return container.textContent ?? "";
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("phase8 android AC5 thread list row shows the run's phase and node beside branch and machine", async () => {
  const text = await renderRow(
    makeShell({ status: "running", phaseIndex: 5, phaseCount: 11, node: "review" }),
  );

  expect(text).toContain("phase 5/11 · Review");
  expect(text).toContain("sf-team/invoice-csv-export");
  expect(text).toContain("vigilia-home");
});

it("phase8 android AC5 thread list row reads waiting, done, degraded or stopped as the run moves", async () => {
  const labels: Array<[FactoryRunShellSummary["status"], string]> = [
    ["waiting", "waiting"],
    ["done", "done"],
    ["degraded", "degraded"],
    ["stopped", "stopped"],
  ];
  for (const [status, label] of labels) {
    const text = await renderRow(
      makeShell({ status, phaseIndex: 2, phaseCount: 2, node: "implement" }),
    );
    expect(text, status).toContain(label);
    expect(text, status).not.toContain("phase 2/2");
  }
});

it("phase8 android AC5 guard thread list row of a thread without a run is unchanged", async () => {
  const withoutRun = await renderRow(makeShell());
  const withNull = await renderRow(makeShell(null));

  expect(withNull).toBe(withoutRun);
  expect(withoutRun).toContain("Invoice CSV export");
  expect(withoutRun).toContain("sf-team/invoice-csv-export");
  expect(withoutRun).not.toMatch(/phase \d+\/\d+|waiting|degraded|stopped/);
});
