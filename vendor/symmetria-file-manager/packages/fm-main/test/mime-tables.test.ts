import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveMimeType } from "@symmetria/fm-core/mime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetMimeTables, mimeTables } from "../src/fs/mimeTables.ts";

/**
 * Parsing the system's own database.
 *
 * Driven against a temporary XDG data directory rather than the machine's, so
 * the test says what it means on any machine — and so a row it needs cannot be
 * absent because a package was not installed.
 */

let root: string;
let originalHome: string | undefined;
let originalDirs: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "symfm-mime-"));
  await mkdir(join(root, "mime"), { recursive: true });

  originalHome = process.env["XDG_DATA_HOME"];
  originalDirs = process.env["XDG_DATA_DIRS"];
  process.env["XDG_DATA_HOME"] = root;
  // Empty, so nothing on the real machine leaks into the result.
  process.env["XDG_DATA_DIRS"] = "";
  forgetMimeTables();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = originalHome;
  if (originalDirs === undefined) delete process.env["XDG_DATA_DIRS"];
  else process.env["XDG_DATA_DIRS"] = originalDirs;

  forgetMimeTables();
  await rm(root, { recursive: true, force: true });
});

async function database(files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, "mime", name), contents, "utf8");
  }
}

describe("mimeTables", () => {
  it("parses globs2 rows into weighted patterns", async () => {
    await database({ globs2: "50:text/plain:*.txt\n50:image/png:*.png\n" });

    expect(resolveMimeType(await mimeTables(), "notes.txt")).toBe("text/plain");
    expect(resolveMimeType(await mimeTables(), "logo.png")).toBe("image/png");
  });

  it("skips comments and blank lines", async () => {
    await database({ globs2: "# a comment\n\n50:text/plain:*.txt\n" });

    expect((await mimeTables()).globs).toHaveLength(1);
  });

  it("reads the case-sensitivity flag from the end of the row", async () => {
    // `*.[Cc]` telling a C source from a C++ one is the only reason this flag
    // exists, and it is the last field rather than a fixed position.
    await database({ globs2: "50:text/x-csrc:*.c:cs\n50:text/plain:*.txt\n" });

    const tables = await mimeTables();
    expect(tables.globs.find((g) => g.pattern === "*.c")?.caseSensitive).toBe(true);
    expect(tables.globs.find((g) => g.pattern === "*.txt")?.caseSensitive).toBeUndefined();
  });

  it("keeps a pattern that contains a colon", async () => {
    // The pattern field is not colon-free, so a naive three-way split truncates
    // it and the type stops resolving.
    await database({ globs2: "50:text/plain:*.a:b\n" });

    expect((await mimeTables()).globs[0]?.pattern).toBe("*.a:b");
  });

  it("accumulates several parents for one type", async () => {
    await database({
      globs2: "50:text/plain:*.txt\n",
      subclasses: "application/json application/javascript\napplication/json text/plain\n",
    });

    expect((await mimeTables()).subclasses.get("application/json")).toEqual([
      "application/javascript",
      "text/plain",
    ]);
  });

  it("reads aliases", async () => {
    await database({ globs2: "", aliases: "application/x-yaml application/yaml\n" });

    expect((await mimeTables()).aliases.get("application/x-yaml")).toBe("application/yaml");
  });

  it("survives a data directory with no database at all", async () => {
    // Normal: not every data directory carries one, and a machine with none
    // still runs — it just resolves fewer types.
    const tables = await mimeTables();

    expect(tables.globs).toEqual([]);
    expect(resolveMimeType(tables, "notes.txt")).toBeNull();
  });

  it("parses once and reuses the result", async () => {
    await database({ globs2: "50:text/plain:*.txt\n" });
    const first = await mimeTables();

    // The database is several thousand rows and does not change while the
    // application runs; re-reading it per preview would put a disk read and a
    // parse on every cursor movement.
    expect(await mimeTables()).toBe(first);
  });
});
