// @effect-diagnostics nodeBuiltinImport:off - Tests exclusive filesystem ownership without a browser.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { createTimelineFixtureOutput } from "./mesura-timeline.find.fixture-output.ts";

it("refuses an existing Find artifact directory without changing its fixture or cache", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-find-output-guard-"));
  const existing = NodePath.join(parent, "retained");
  NodeFS.mkdirSync(NodePath.join(existing, ".cache"), { recursive: true });
  const sentinels = ["fixture.html", "fixture.bundle.js", ".cache/sentinel"];
  for (const name of sentinels) NodeFS.writeFileSync(NodePath.join(existing, name), name);
  let output: ReturnType<typeof createTimelineFixtureOutput> | undefined;
  try {
    expect(() => {
      output = createTimelineFixtureOutput(existing);
    }).toThrow();
  } finally {
    output?.dispose();
  }
  try {
    for (const name of sentinels)
      expect(NodeFS.readFileSync(NodePath.join(existing, name), "utf8")).toBe(name);
    expect(NodeFS.readdirSync(existing).sort()).toEqual([
      ".cache",
      "fixture.bundle.js",
      "fixture.html",
    ]);
  } finally {
    NodeFS.rmSync(parent, { recursive: true });
  }
});

it("cleans only generated Find files and retains receipts in its exclusively created directory", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-find-output-owned-"));
  const output = createTimelineFixtureOutput(NodePath.join(parent, "retained"));
  try {
    NodeFS.writeFileSync(NodePath.join(output.directory, "fixture.html"), "synthetic");
    NodeFS.mkdirSync(NodePath.join(output.directory, ".cache"));
    output.writeReceipt("numeric.json", { targetTop: 96 });
    output.dispose();
    expect(NodeFS.readdirSync(output.directory)).toEqual(["numeric.json"]);
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(output.directory, "numeric.json"), "utf8")),
    ).toEqual({ targetTop: 96 });
  } finally {
    NodeFS.rmSync(parent, { recursive: true });
  }
});
