// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  WorkloadListResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type WorkloadControlResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ensureClientSettingsHydrated } from "../../hooks/useSettings";
import {
  actEffect,
  controlOutcomes,
  ENVIRONMENT,
  makeWorkloadHarness,
  OTHER_ENVIRONMENT,
  OTHER_THREAD,
  RECORD,
  THREAD,
  workload,
  workloadList,
  type WorkloadHarness,
} from "../../state/workloads.testkit";
import { WorkloadList } from "./WorkloadList";

const decodeWorkloadList = Schema.decodeUnknownEffect(WorkloadListResult);

let harness: WorkloadHarness;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness = await makeWorkloadHarness();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  harness.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(thread = false) {
  await act(async () =>
    root.render(
      harness.provider(
        <WorkloadList
          environmentId={ENVIRONMENT}
          {...(thread ? { threadId: THREAD } : {})}
          visible
        />,
      ),
    ),
  );
  await harness.read(thread ? { threadId: THREAD } : {});
}
function button(label: string) {
  const node = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(node).not.toBeNull();
  return node!;
}
async function refresh() {
  await act(async () => harness.atoms.refreshEnvironment(harness.registry, ENVIRONMENT));
  await harness.read();
}

describe("shared workload rows", () => {
  it("uses the finalized decoder default for an older server without shared RAM", async () => {
    const { sharedAgentRam: _sharedAgentRam, ...oldReply } = workloadList();
    harness.replies.list = () => decodeWorkloadList(oldReply);
    await mount();
    expect(container.textContent).toContain("Shared agent RAM unsupported on this host");
    expect(container.textContent).toContain("16 MiB RAM");
    expect(container.querySelector("[data-shared-agent-group]")).toBeNull();
  });
  it.each(controlOutcomes)(
    "publishes the typed %j result and refreshes without replay",
    async (result, title, detail) => {
      const row = result.operation === "start" ? workload({ managerState: "stopped" }) : workload();
      harness.replies.list = () => Effect.succeed(workloadList([row]));
      harness.replies.control = () => Effect.succeed(result);
      await mount();
      const before = harness.calls.list.length;
      const settled = harness.settledControl();
      await act(async () => {
        button(`${result.operation === "start" ? "Start" : "Stop"} Frontend preview`).click();
        await settled;
      });
      await harness.read();
      expect(container.textContent).toContain(title);
      expect(container.textContent).toContain(detail);
      expect(harness.calls.list.length).toBeGreaterThan(before);
      expect(harness.calls.controls).toHaveLength(1);
      expect(container.textContent).toContain(
        result.operation === "start" ? "○ Stopped" : "● Running",
      );
    },
  );
  it("uses scope RAM, retains truthful ownership and withholds controls and links for unassigned rows", async () => {
    harness.replies.list = () =>
      Effect.succeed(
        workloadList([
          workload({
            association: { state: "unassigned", threadId: null, reason: "ambiguous" },
            ramBytes: null,
            remoteUrl: null,
          }),
        ]),
      );
    await mount();
    expect(container.textContent).toContain("Unassigned");
    expect(container.textContent).toContain("RAM unavailable");
    expect(container.textContent).not.toContain("128 MiB");
    expect(container.textContent).not.toContain("0 B RAM");
    expect(button("Stop Frontend preview").disabled).toBe(true);
    expect(container.querySelector('[aria-label="Open Frontend preview"]')).toBeNull();
    expect(container.textContent).toContain("No remote link available");
    expect(harness.calls.controls).toHaveLength(0);
  });
  it.effect(
    "shares pending controls across Hosts and thread lists and sends only the current record and owner",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<WorkloadControlResult>();
        harness.replies.list = () => Effect.succeed(workloadList([workload()]));
        harness.replies.control = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            return yield* Deferred.await(release);
          });
        yield* Effect.promise(() =>
          act(async () =>
            root.render(
              harness.provider(
                <>
                  <WorkloadList environmentId={ENVIRONMENT} visible />
                  <WorkloadList environmentId={ENVIRONMENT} threadId={THREAD} visible />
                </>,
              ),
            ),
          ),
        );
        yield* Effect.promise(() => harness.read());
        yield* Effect.promise(() => harness.read({ threadId: THREAD }));
        const controls = [
          ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Stop Frontend preview"]'),
        ];
        expect(controls).toHaveLength(2);
        yield* actEffect(
          Effect.sync(() => controls[0]!.click()).pipe(Effect.andThen(Deferred.await(entered))),
        );
        expect(controls.every((control) => control.disabled)).toBe(true);
        expect(container.textContent).toContain("Stopping…");
        controls[1]!.click();
        expect(harness.calls.controls).toHaveLength(1);
        expect(harness.calls.controls[0]).toEqual({
          environmentId: ENVIRONMENT,
          operation: "stop",
          input: { recordId: RECORD, threadId: THREAD },
        });
        const settled = harness.settledControl();
        yield* actEffect(
          Deferred.succeed(release, {
            recordId: RECORD,
            status: "refused",
            operation: "stop",
            reason: "owner-mismatch",
            managerState: "running",
            mutationAttempted: false,
          }).pipe(Effect.andThen(Effect.promise(() => settled))),
        );
        yield* Effect.promise(() => harness.read());
        yield* Effect.promise(() => harness.read({ threadId: THREAD }));
        expect(container.textContent).toContain("Stop refused");
        expect(container.textContent).toContain("The owning thread changed");
        expect(container.textContent).toContain("Running");
        expect(harness.calls.controls).toHaveLength(1);
      }),
  );
  it("observes a changed owner after refusal and uses it only on the next explicit action", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_791_910_800_000);
    harness.replies.control = () => {
      harness.replies.list = () =>
        Effect.succeed(
          workloadList([
            workload({ association: { state: "assigned", threadId: OTHER_THREAD, reason: null } }),
          ]),
        );
      return Effect.succeed({
        recordId: RECORD,
        status: "refused",
        operation: "stop",
        reason: "owner-mismatch",
        managerState: "running",
        mutationAttempted: false,
      });
    };
    await mount();
    const first = harness.settledControl();
    await act(async () => {
      button("Stop Frontend preview").click();
      await first;
    });
    await harness.read();
    expect(harness.calls.controls).toHaveLength(1);
    expect(button("Stop Frontend preview").disabled).toBe(true);
    expect(container.textContent).toContain("Stop refused");
    vi.setSystemTime(1_791_910_801_000);
    await act(async () => button("Refresh workloads").click());
    await harness.read();
    expect(button("Stop Frontend preview").disabled).toBe(false);
    const second = harness.settledControl();
    await act(async () => {
      button("Stop Frontend preview").click();
      await second;
    });
    expect(harness.calls.controls.map((call) => call.input.threadId)).toEqual([
      THREAD,
      OTHER_THREAD,
    ]);
  });
  it("does not call an accepted start running when the manager state is unknown", async () => {
    harness.replies.list = () =>
      Effect.succeed(workloadList([workload({ managerState: "stopped" })]));
    harness.replies.control = () =>
      Effect.succeed({
        recordId: RECORD,
        status: "completed",
        operation: "start",
        result: "admitted",
        mutationAttempted: true,
        registration: "recorded",
        managerState: "unknown",
      });
    await mount();
    const settled = harness.settledControl();
    await act(async () => {
      button("Start Frontend preview").click();
      await settled;
    });
    await harness.read();
    expect(container.textContent).toContain("Start accepted");
    expect(container.textContent).toContain("Launch recorded. Host state: unknown");
    expect(container.textContent).not.toContain("● Running");
    expect(harness.calls.controls).toHaveLength(1);
  });
  it("keeps diagnostics reading available when maintenance is absent", async () => {
    await harness.grant(ENVIRONMENT, [AuthDiagnosticsReadScope]);
    await mount();
    expect(container.textContent).toContain("Frontend preview");
    expect(button("Stop Frontend preview").disabled).toBe(true);
    expect(container.textContent).toContain("Control access unavailable on this host");
  });
  it("opens only the returned URL through the existing browser policy", async () => {
    await ensureClientSettingsHydrated();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    await mount(true);
    await act(async () => {
      button("Open Frontend preview").dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true }),
      );
    });
    expect(opened).toHaveBeenCalledWith(
      "https://preview.example.test:5173",
      "_blank",
      "noopener,noreferrer",
    );
    harness.replies.list = () => Effect.succeed(workloadList([workload({ remoteUrl: null })]));
    await act(async () => harness.atoms.refreshEnvironment(harness.registry, ENVIRONMENT));
    await harness.read({ threadId: THREAD });
    expect(container.querySelector('[aria-label="Open Frontend preview"]')).toBeNull();
    expect(opened).toHaveBeenCalledTimes(1);
  });
  it("shows full shared anonymous bytes once per group, without division, aggregation or unavailable zeros", async () => {
    const identity = {
      groupId: "a0000000-0000-4000-8000-000000000000",
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex-main"),
      attachedThreadCount: 4,
    };
    harness.replies.list = () =>
      Effect.succeed(
        workloadList([], {
          sharedAgentRam: {
            status: "unavailable",
            incomplete: true,
            groups: [
              {
                ...identity,
                status: "available",
                anonymousBytes: 64 * 1024 * 1024,
                sampledAt: "2026-10-13T16:00:00.000Z",
                reason: null,
              },
              {
                ...identity,
                groupId: "b0000000-0000-4000-8000-000000000000",
                instanceId: ProviderInstanceId.make("codex-other"),
                status: "unavailable",
                anonymousBytes: null,
                sampledAt: null,
                reason: "identity_changed",
              },
            ],
          },
        }),
      );
    await mount();
    const groups = container.querySelectorAll("[data-shared-agent-group]");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain("64 MiB RAM");
    expect(groups[0]!.textContent).toContain("4 attached threads");
    expect(groups[1]!.textContent).toContain("RAM unavailable");
    expect(groups[1]!.textContent).toContain("identity changed");
    expect(container.textContent).not.toContain("16 MiB");
    expect(container.textContent).not.toContain("0 B RAM");
    expect(container.textContent).toContain("observations are incomplete");
    expect(container.textContent).toContain("including its resident processes");
    expect(container.textContent).toContain("Per-thread agent RAM unavailable");
  });
  it("keys identical opaque group IDs independently on distinct environments and treats available-empty as absence", async () => {
    const group = {
      groupId: "a0000000-0000-4000-8000-000000000000",
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex-main"),
      attachedThreadCount: 2,
      status: "available" as const,
      anonymousBytes: 8 * 1024 * 1024,
      sampledAt: "2026-10-13T16:00:00.000Z",
      reason: null,
    };
    harness.replies.list = () =>
      Effect.succeed(
        workloadList([], {
          sharedAgentRam: { status: "available", groups: [group], incomplete: false },
        }),
      );
    await act(async () =>
      root.render(
        harness.provider(
          <>
            <WorkloadList environmentId={ENVIRONMENT} visible />
            <WorkloadList environmentId={OTHER_ENVIRONMENT} visible />
          </>,
        ),
      ),
    );
    await harness.read();
    await harness.read({}, OTHER_ENVIRONMENT);
    expect(container.querySelectorAll("[data-shared-agent-group]")).toHaveLength(2);
    harness.replies.list = () =>
      Effect.succeed(
        workloadList([], {
          sharedAgentRam: { status: "available", groups: [], incomplete: false },
        }),
      );
    await refresh();
    expect(container.querySelector(`[data-workload-list="${ENVIRONMENT}"]`)!.textContent).toContain(
      "No shared agent runtime groups",
    );
    expect(
      container.querySelector(`[data-workload-list="${ENVIRONMENT}"]`)!.textContent,
    ).not.toContain("0 B RAM");
  });
});
