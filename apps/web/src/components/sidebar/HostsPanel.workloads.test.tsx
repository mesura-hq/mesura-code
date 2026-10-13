// @vitest-environment happy-dom
import { projectHostStats } from "@t3tools/client-runtime/host-stats";
import { hostStatsFleet } from "@t3tools/client-runtime/host-stats/fixtures";
import type { HostStatsHostView } from "@t3tools/client-runtime/host-stats";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  ENVIRONMENT,
  makeWorkloadHarness,
  OTHER_ENVIRONMENT,
  RECORD,
  THREAD,
  workload,
  workloadList,
  type WorkloadHarness,
} from "../../state/workloads.testkit";
import { HostsPanelContent } from "./HostsPanel";

let root: Root;
let container: HTMLDivElement;
let harness: WorkloadHarness;
let hosts: readonly HostStatsHostView[];
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness = await makeWorkloadHarness();
  const nowLocal = Date.now();
  const projected = projectHostStats({ ...hostStatsFleet(nowLocal), nowLocal });
  hosts = [
    { ...projected[0]!, environmentId: ENVIRONMENT, label: "Workload host A" },
    { ...projected[1]!, environmentId: OTHER_ENVIRONMENT, label: "Workload host B" },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  harness.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(open = true) {
  await act(async () =>
    root.render(
      harness.provider(<HostsPanelContent hosts={hosts} open={open} shortcutLabel={null} />),
    ),
  );
}

describe("Host workloads beside host readings", () => {
  it("queries each destination without a thread filter and keeps host readings separate from registered workloads", async () => {
    harness.replies.list = (environmentId) =>
      Effect.succeed(
        workloadList([
          workload({ name: environmentId === ENVIRONMENT ? "Host A preview" : "Host B preview" }),
        ]),
      );
    await render();
    await harness.read();
    await harness.read({}, OTHER_ENVIRONMENT);
    expect(harness.calls.list).toEqual(
      expect.arrayContaining([
        { environmentId: ENVIRONMENT, input: {} },
        { environmentId: OTHER_ENVIRONMENT, input: {} },
      ]),
    );
    const a = container.querySelector(`[data-host="${ENVIRONMENT}"]`)!;
    const b = container.querySelector(`[data-host="${OTHER_ENVIRONMENT}"]`)!;
    expect(a.textContent).toContain("Host A preview");
    expect(a.textContent).not.toContain("Host B preview");
    expect(b.textContent).toContain("Host B preview");
    expect(a.querySelector('[data-host-row="cpu"]')).not.toBeNull();
    const settled = harness.settledControl(OTHER_ENVIRONMENT);
    await act(async () => {
      b.querySelector<HTMLButtonElement>('[aria-label="Stop Host B preview"]')!.click();
      await settled;
    });
    expect(harness.calls.controls[0]).toEqual({
      environmentId: OTHER_ENVIRONMENT,
      operation: "stop",
      input: { recordId: RECORD, threadId: THREAD },
    });
  });
  it("still shows workload availability when host-stat rows are unavailable, and removes queries on close", async () => {
    hosts = hosts.map((host) => ({ ...host, rows: null }));
    await render();
    await harness.read();
    await harness.read({}, OTHER_ENVIRONMENT);
    expect(container.textContent).toContain("Frontend preview");
    await render(false);
    expect(container.querySelector("[data-workload-list]")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const before = harness.calls.list.length;
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(harness.calls.list.length).toBe(before);
  });
});
