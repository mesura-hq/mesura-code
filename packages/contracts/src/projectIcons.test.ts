// Entry point: the `OrchestrationShellStreamEvent` schema, which every client
// decodes for a `project-upserted` shell event. A Luna search outcome reaches
// the client only if this decode keeps the project's discovery state.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationShellStreamEvent } from "./orchestration.ts";

const decodeShellEvent = Schema.decodeUnknownSync(OrchestrationShellStreamEvent);
const encodeShellEvent = Schema.encodeSync(OrchestrationShellStreamEvent);

const project = {
  id: "project-icons",
  title: "Icons",
  workspaceRoot: "/workspace/icons",
  defaultModelSelection: null,
  faviconPath: "public/brand-logo.svg",
  projectIcon: null,
  scripts: [],
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
};
const iconDiscovery = {
  generation: 2,
  jobToken: "request-2",
  workspaceRoot: "/workspace/icons",
  startingFaviconPath: null,
  startingProjectIcon: null,
  status: "selected",
  path: "public/brand-logo.svg",
  reason: "The brand mark.",
  updatedAt: "2026-10-11T00:01:00.000Z",
};

describe("project icon discovery on the shell stream", () => {
  it("icon discovery contract: a project upsert carries the search outcome to the client", () => {
    const event = decodeShellEvent({
      kind: "project-upserted",
      sequence: 7,
      project: { ...project, iconDiscovery },
    });
    expect(event.kind === "project-upserted" && event.project.iconDiscovery).toEqual(iconDiscovery);
    expect(decodeShellEvent(encodeShellEvent(event))).toEqual(event);
  });

  it("icon discovery contract: a project from an older server decodes without discovery state", () => {
    const event = decodeShellEvent({ kind: "project-upserted", sequence: 7, project });
    expect(event.kind === "project-upserted" && event.project.iconDiscovery).toBeUndefined();
  });
});
