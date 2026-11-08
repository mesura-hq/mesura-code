// @effect-diagnostics nodeBuiltinImport:off - These tests stage symlink swaps with Node's filesystem calls.
// Entry point: `writeProjectIconFile`, the import write the thread tool uses,
// running its real writer process. The writer inherits `NODE_OPTIONS`, so a
// `--require` preload written to a temporary directory swaps an import
// directory at an exact step inside that process: before it enters a
// directory, or after it entered one and before it creates the file. Nothing
// in the product code knows about the preload.
//
// Project icons phase 2, acceptance criterion 4 and review finding P1-3: a
// directory swapped for an outside symlink while the writer runs creates
// nothing outside the project.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { PROJECT_ICON_MAX_BYTES } from "./ProjectIconCandidates.ts";
import { writeProjectIconFile } from "./ProjectIconFile.ts";

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

/**
 * The preload; `ICON_WRITER_SWAP` names the step and paths. `before-enter` replaces `<swap>`
 * with a link to `<outside>` right before the writer enters the directory `<segment>`.
 * `before-create` renames `<swap>` to `<moved>` and links `<swap>` to `<outside>` after the
 * writer entered its last directory, right before it creates the file.
 */
const PRELOAD = `
"use strict";
const fs = require("node:fs");
const swap = JSON.parse(process.env.ICON_WRITER_SWAP);
const link = () => fs.symlinkSync(swap.outside, swap.swap);
if (swap.step === "before-enter") {
  const chdir = process.chdir;
  process.chdir = function (target) {
    if (target === swap.segment) {
      fs.rmSync(swap.swap, { recursive: true, force: true });
      link();
    }
    return chdir.call(process, target);
  };
} else {
  const openSync = fs.openSync;
  fs.openSync = function (target, flags, ...rest) {
    if (flags === "wx") {
      fs.renameSync(swap.swap, swap.moved);
      link();
    }
    return openSync.call(fs, target, flags, ...rest);
  };
}
`;

let scratch: string;
let root: string;
let outside: string;
let preloadPath: string;

beforeEach(() => {
  scratch = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "icon-writer-")));
  root = NodePath.join(scratch, "project");
  outside = NodePath.join(scratch, "outside");
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(outside);
  preloadPath = NodePath.join(scratch, "swap-preload.cjs");
  NodeFS.writeFileSync(preloadPath, PRELOAD);
});

afterEach(() => {
  // Restore the variables in place: replacing process.env leaves Node 26's
  // native spawn environment pointing at a preload that cleanup deletes.
  vi.unstubAllEnvs();
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const withSwap = (swap: Record<string, string>) => {
  vi.stubEnv("NODE_OPTIONS", `--require ${preloadPath}`);
  vi.stubEnv("ICON_WRITER_SWAP", JSON.stringify(swap));
};

const write = (bytes: Buffer = SVG) =>
  writeProjectIconFile({ workspaceRoot: root, bytes, extension: ".svg" });

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const outsideEntries = () => NodeFS.readdirSync(outside, { recursive: true });

describe("project icon writer", () => {
  it("project icon writer regression: a replaced environment still controls the writer", async () => {
    const environment = process.env;
    process.env = {
      ...environment,
      NODE_OPTIONS: `--require ${preloadPath}`,
      ICON_WRITER_SWAP: JSON.stringify({
        step: "before-enter",
        segment: ".mesura",
        swap: NodePath.join(root, ".mesura"),
        outside,
      }),
    };
    try {
      expect(await failureOf(write())).toContain("link or moved outside the project");
      expect(outsideEntries()).toEqual([]);
    } finally {
      process.env = environment;
    }
  });

  it("project icon writer regression: a .mesura link swapped in before entry writes nothing outside", async () => {
    withSwap({
      step: "before-enter",
      segment: ".mesura",
      swap: NodePath.join(root, ".mesura"),
      outside,
    });
    expect(await failureOf(write())).toContain("link or moved outside the project");
    expect(outsideEntries()).toEqual([]);
  });

  it("project icon writer regression: a project-icons link swapped in before entry writes nothing outside", async () => {
    withSwap({
      step: "before-enter",
      segment: "project-icons",
      swap: NodePath.join(root, ".mesura", "project-icons"),
      outside,
    });
    expect(await failureOf(write())).toContain("link or moved outside the project");
    expect(outsideEntries()).toEqual([]);
  });

  it("project icon writer regression: a link swapped in after entry cannot redirect the new file", async () => {
    // A first import leaves the directories in place for the swap.
    await write(Buffer.from("<svg id='first'/>"));
    const icons = NodePath.join(root, ".mesura", "project-icons");
    const moved = NodePath.join(root, ".mesura", "pinned");
    withSwap({ step: "before-create", swap: icons, moved, outside });
    const failure = await failureOf(write());
    // The writer created the file in the directory it had entered, now named
    // `pinned`; the path check after it then refuses to report it as saved.
    expect(failure).toContain("not a valid project icon");
    expect(outsideEntries()).toEqual([]);
    expect(NodeFS.readdirSync(moved)).toHaveLength(2);
  });

  it("project icon writer regression: the server process keeps its working directory", async () => {
    const before = process.cwd();
    await write();
    withSwap({
      step: "before-enter",
      segment: ".mesura",
      swap: NodePath.join(root, ".mesura"),
      outside,
    });
    await failureOf(write(Buffer.from("<svg id='other'/>")));
    expect(process.cwd()).toBe(before);
  });

  it("project icon writer regression: the same image again reuses its file", async () => {
    const first = await write();
    expect(await write()).toBe(first);
    expect(NodeFS.readdirSync(NodePath.join(root, ".mesura", "project-icons"))).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(root, first))).toEqual(SVG);
  });

  it("project icon writer regression: a different file under the content name is refused", async () => {
    const saved = await write();
    const destination = NodePath.join(root, saved);
    // The same length with other bytes is compared through a bounded read.
    NodeFS.writeFileSync(destination, Buffer.alloc(SVG.length, "x"));
    expect(await failureOf(write())).toContain(
      "A different file already uses this project icon name.",
    );
    // A larger file is refused by its size before any read.
    NodeFS.writeFileSync(destination, Buffer.alloc(PROJECT_ICON_MAX_BYTES * 2, "x"));
    expect(await failureOf(write())).toContain(
      "A different file already uses this project icon name.",
    );
    // A link at the content name is never followed.
    NodeFS.rmSync(destination);
    NodeFS.writeFileSync(NodePath.join(outside, "target.svg"), SVG);
    NodeFS.symlinkSync(NodePath.join(outside, "target.svg"), destination);
    expect(await failureOf(write())).toContain(
      "A different file already uses this project icon name.",
    );
    expect(NodeFS.readFileSync(NodePath.join(outside, "target.svg"))).toEqual(SVG);
  });

  it("project icon writer regression: bytes over the limit are refused before any directory exists", async () => {
    expect(await failureOf(write(Buffer.alloc(PROJECT_ICON_MAX_BYTES + 1, "x")))).toContain(
      "at most 2 MiB",
    );
    expect(NodeFS.readdirSync(root)).toEqual([]);
  });
});
