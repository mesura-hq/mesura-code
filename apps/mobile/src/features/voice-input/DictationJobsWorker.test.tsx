// @vitest-environment happy-dom
// Phase 7 (mobile dictation), coordinator decision 4: the job stream is watched once per host.
// Entry point: `DictationJobsWorker`, the root worker `Stack.tsx` mounts beside the outbox
// drain. Stubbed edges: the server configs (`useServerConfigs`) and `watchDictationJobs`, whose
// delivery is pinned in `state/dictation.test.ts`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SECRET_SETTING_REDACTION_MARKER } from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  watch: vi.fn<(environmentId: string) => () => void>(),
  stops: [] as string[],
}));

vi.mock("../../state/entities", () => ({ useServerConfigs: () => fixture.configs }));
vi.mock("../../state/dictation", () => ({ watchDictationJobs: fixture.watch }));

import { DictationJobsWorker } from "./DictationJobsWorker";

const withKey = { settings: { dictation: { openAiApiKey: SECRET_SETTING_REDACTION_MARKER } } };
const withoutKey = { settings: { dictation: { openAiApiKey: "" } } };
const desk = EnvironmentId.make("worker-desk");
const laptop = EnvironmentId.make("worker-laptop");
const bare = EnvironmentId.make("worker-bare");

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.stops = [];
  fixture.watch.mockReset();
  fixture.watch.mockImplementation((environmentId) => () => {
    fixture.stops.push(environmentId);
  });
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

const render = () => act(() => root.render(<DictationJobsWorker />));

describe("mobile dictation job worker", () => {
  it("watches the dictation jobs once per host that has a key", () => {
    fixture.configs = new Map([
      [desk, withKey],
      [laptop, withKey],
      [bare, withoutKey],
    ]);
    render();
    expect(fixture.watch.mock.calls.map(([id]) => id).sort()).toEqual([desk, laptop].sort());
  });

  it("keeps each host's dictation watch across re-renders, as navigation causes", () => {
    fixture.configs = new Map([[desk, withKey]]);
    render();
    // A new config map, as a reconnect or another screen's update publishes it.
    fixture.configs = new Map([[desk, withKey]]);
    render();
    render();
    expect(fixture.watch).toHaveBeenCalledOnce();
    expect(fixture.stops).toEqual([]);
  });

  it("stops watching a host's dictation jobs once its key is removed", () => {
    fixture.configs = new Map([[desk, withKey]]);
    render();
    fixture.configs = new Map([[desk, withoutKey]]);
    render();
    expect(fixture.stops).toEqual([desk]);
  });

  // Guard: the root stack mounts the worker beside the outbox drain, outside every screen.
  it("is mounted by the root stack layout beside the outbox drain", () => {
    const stack = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../../Stack.tsx"),
      "utf8",
    );
    expect(stack).toMatch(/<ThreadOutboxDrainWorker \/>\s*<DictationJobsWorker \/>/);
  });
});
