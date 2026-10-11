// Entry point: the `OrchestrationShellStreamEvent` schema, which every client
// decodes for a `project-upserted` shell event. A Luna search outcome reaches
// the client only if this decode keeps the project's discovery state.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationShellStreamEvent } from "./orchestration.ts";
import {
  describeProjectIconChange,
  ProjectIconDiscoveryPreview,
  ProjectIconEffectiveSource,
} from "./projectIcons.ts";

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

// The agent tool and the web client both show these words, so they pin the
// one shared description of what a manual save or reset leaves on screen.
describe("describeProjectIconChange", () => {
  it("project icon wording: a save that displays says only that it was saved", () => {
    expect(describeProjectIconChange("saved", "project")).toBe("Project icon saved.");
  });

  it("project icon wording: a save masked by higher precedence names what still displays", () => {
    const masked = describeProjectIconChange("saved", "mesura");
    expect(masked).toMatch(/^Project icon saved, but /);
    expect(masked).toContain(".mesura.json");
    expect(masked).toContain("takes precedence");
    expect(describeProjectIconChange("saved", "custom")).toContain("custom icon still displays");
  });

  it("project icon wording: a save shown below lower precedence says the image was not found", () => {
    for (const source of ["t3", "detected", "initials"] as const) {
      const missing = describeProjectIconChange("saved", source);
      expect(missing).toMatch(/^Project icon saved, but the image was not found in this checkout/);
      expect(missing).not.toContain("takes precedence");
    }
    expect(describeProjectIconChange("saved", "t3")).toContain("t3.json");
    expect(describeProjectIconChange("saved", "initials")).toContain("initials");
  });

  it("project icon wording: a reset names the fallback and that no search started", () => {
    for (const source of ProjectIconEffectiveSource.literals) {
      const reset = describeProjectIconChange("reset", source);
      expect(reset).toMatch(/^Saved project icon cleared; /);
      expect(reset).toContain("No Luna search was started.");
    }
    expect(describeProjectIconChange("reset", "mesura")).toContain(".mesura.json now displays");
    expect(describeProjectIconChange("reset", "initials")).toContain("initials now displays");
  });
});

describe("ProjectIconDiscoveryPreview", () => {
  it("project icon wording: a preview without an effective source still decodes", () => {
    const decode = Schema.decodeUnknownSync(ProjectIconDiscoveryPreview);
    const base = { projectId: "project", title: "P", candidateCount: 0, reason: "r" };
    expect(decode({ ...base, status: "failed" }).effectiveSource).toBeUndefined();
    expect(decode({ ...base, status: "existing", effectiveSource: "mesura" }).effectiveSource).toBe(
      "mesura",
    );
    expect(() => decode({ ...base, status: "existing", effectiveSource: "somewhere" })).toThrow();
  });
});
