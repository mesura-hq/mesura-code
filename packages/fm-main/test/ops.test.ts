import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEntry, renameEntry, transfer } from "../src/ops/mutate.ts";
import { desktopEntryKeys } from "../src/ops/open.ts";

/**
 * The mutations, against a real filesystem.
 *
 * Real because these are the operations that lose data when they are wrong, and
 * a fake filesystem agrees with whatever the implementation believes. The one
 * thing not exercised here is trash — it is delegated to Electron's
 * implementation of the freedesktop specification, which needs a running
 * Electron and which reimplementing would be a way to lose files.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "symfm-ops-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A directory holding a file and a nested directory with a file in it. */
async function tree(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, "top.txt"), "top");
  await writeFile(join(dir, "nested", "deep.txt"), "deep");
  return dir;
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("copy", () => {
  it("duplicates a directory and everything under it", async () => {
    const source = await tree("source");
    const destination = join(root, "into");
    await mkdir(destination);

    const outcome = await transfer({
      sources: [source],
      destination,
      mode: "copy",
      overwrite: false,
    });

    expect(outcome).toEqual({ moved: 1, conflicts: [] });
    expect(await readFile(join(destination, "source", "nested", "deep.txt"), "utf8")).toBe("deep");
    // The original is still there. A copy that moves is a move.
    expect(await names(source)).toEqual(["nested", "top.txt"]);
  });

  it("copies several entries in one transfer", async () => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const destination = join(root, "into");
    await mkdir(destination);

    const outcome = await transfer({
      sources: [join(root, "a.txt"), join(root, "b.txt")],
      destination,
      mode: "copy",
      overwrite: false,
    });

    expect(outcome.moved).toBe(2);
    expect(await names(destination)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("move", () => {
  it("moves the entries and leaves nothing behind", async () => {
    const source = await tree("source");
    const destination = join(root, "into");
    await mkdir(destination);

    await transfer({ sources: [source], destination, mode: "move", overwrite: false });

    expect(await names(root)).toEqual(["into"]);
    expect(await readFile(join(destination, "source", "top.txt"), "utf8")).toBe("top");
  });
});

describe("conflicts", () => {
  it("names every collision and transfers NOTHING", async () => {
    // Transferring three files and asking about the fourth leaves the user
    // reasoning about a partial result. Naming them all lets them answer once.
    await writeFile(join(root, "a.txt"), "new a");
    await writeFile(join(root, "b.txt"), "new b");
    const destination = join(root, "into");
    await mkdir(destination);
    await writeFile(join(destination, "a.txt"), "old a");
    await writeFile(join(destination, "b.txt"), "old b");

    const outcome = await transfer({
      sources: [join(root, "a.txt"), join(root, "b.txt")],
      destination,
      mode: "copy",
      overwrite: false,
    });

    expect(outcome).toEqual({ moved: 0, conflicts: ["a.txt", "b.txt"] });
    expect(await readFile(join(destination, "a.txt"), "utf8")).toBe("old a");
  });

  it("stops even when only one of several entries collides", async () => {
    await writeFile(join(root, "a.txt"), "new a");
    await writeFile(join(root, "c.txt"), "new c");
    const destination = join(root, "into");
    await mkdir(destination);
    await writeFile(join(destination, "a.txt"), "old a");

    const outcome = await transfer({
      sources: [join(root, "a.txt"), join(root, "c.txt")],
      destination,
      mode: "copy",
      overwrite: false,
    });

    expect(outcome.conflicts).toEqual(["a.txt"]);
    expect(await names(destination)).toEqual(["a.txt"]);
  });

  it("replaces when the caller says to, having been asked", async () => {
    await writeFile(join(root, "a.txt"), "new a");
    const destination = join(root, "into");
    await mkdir(destination);
    await writeFile(join(destination, "a.txt"), "old a");

    await transfer({
      sources: [join(root, "a.txt")],
      destination,
      mode: "copy",
      overwrite: true,
    });

    expect(await readFile(join(destination, "a.txt"), "utf8")).toBe("new a");
  });

  it("treats a broken symlink as being in the way", async () => {
    // It occupies the name, so writing there would replace it — and it may be
    // the only record of where something used to point.
    const { symlink } = await import("node:fs/promises");
    await writeFile(join(root, "a.txt"), "a");
    const destination = join(root, "into");
    await mkdir(destination);
    await symlink(join(root, "gone"), join(destination, "a.txt"));

    const outcome = await transfer({
      sources: [join(root, "a.txt")],
      destination,
      mode: "copy",
      overwrite: false,
    });

    expect(outcome.conflicts).toEqual(["a.txt"]);
  });
});

describe("refusals", () => {
  it("refuses to put a directory inside itself", async () => {
    // `cp -r a a/b` is an infinite tree, and `mv` refuses it outright.
    const source = await tree("source");

    await expect(
      transfer({
        sources: [source],
        destination: join(source, "nested"),
        mode: "copy",
        overwrite: false,
      }),
    ).rejects.toThrow(/into itself/);
  });

  it("refuses a destination several levels inside the source", async () => {
    const source = await tree("source");
    await mkdir(join(source, "nested", "deeper"), { recursive: true });

    await expect(
      transfer({
        sources: [source],
        destination: join(source, "nested", "deeper"),
        mode: "move",
        overwrite: false,
      }),
    ).rejects.toThrow(/into itself/);
  });
});

describe("cancellation", () => {
  it("stops between entries, leaving whole ones behind", async () => {
    // A cancelled transfer must never leave a half-written file. Checking
    // between entries is what guarantees that.
    for (let i = 0; i < 6; i++) await writeFile(join(root, `f${i}.txt`), `${i}`);
    const destination = join(root, "into");
    await mkdir(destination);

    const controller = new AbortController();
    const outcome = await transfer({
      sources: Array.from({ length: 6 }, (_, i) => join(root, `f${i}.txt`)),
      destination,
      mode: "copy",
      overwrite: false,
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 2) controller.abort();
      },
    });

    expect(outcome.moved).toBe(2);
    expect(await names(destination)).toEqual(["f0.txt", "f1.txt"]);
  });

  it("reports progress from zero to the total", async () => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const destination = join(root, "into");
    await mkdir(destination);

    const seen: string[] = [];
    await transfer({
      sources: [join(root, "a.txt"), join(root, "b.txt")],
      destination,
      mode: "copy",
      overwrite: false,
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });

    // The leading zero is what lets a caller show a bar before anything lands.
    expect(seen).toEqual(["0/2", "1/2", "2/2"]);
  });
});

describe("create", () => {
  it("creates a file, and the directories above it", async () => {
    // What `mkdir -p` gave the Qt build, and what makes typing a path into the
    // create dialog do what it looks like it does.
    await createEntry(join(root, "notes", "2026", "august.md"), "file");

    expect((await stat(join(root, "notes", "2026", "august.md"))).isFile()).toBe(true);
  });

  it("creates a directory and its parents", async () => {
    await createEntry(join(root, "a", "b", "c"), "directory");

    expect((await stat(join(root, "a", "b", "c"))).isDirectory()).toBe(true);
  });

  it("refuses to empty a file that is already there", async () => {
    // An accidental second Enter on the create dialog must not truncate.
    await writeFile(join(root, "kept.txt"), "important");

    await expect(createEntry(join(root, "kept.txt"), "file")).rejects.toThrow();
    expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("important");
  });

  it("is content for a directory that already exists", async () => {
    await mkdir(join(root, "there"));
    await expect(createEntry(join(root, "there"), "directory")).resolves.toBeUndefined();
  });
});

describe("rename", () => {
  it("renames in place", async () => {
    await writeFile(join(root, "before.txt"), "x");

    const renamed = await renameEntry(join(root, "before.txt"), "after.txt");

    expect(renamed).toBe(join(root, "after.txt"));
    expect(await names(root)).toEqual(["after.txt"]);
  });

  it("refuses a name that is already taken, and says which", async () => {
    // `rename` would silently replace the other entry, and the other entry may
    // be the only copy of something.
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");

    await expect(renameEntry(join(root, "a.txt"), "b.txt")).rejects.toThrow(
      /b\.txt already exists/,
    );
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("b");
  });

  it("accepts renaming an entry to the name it already has", async () => {
    await writeFile(join(root, "same.txt"), "x");

    await expect(renameEntry(join(root, "same.txt"), "same.txt")).resolves.toBe(
      join(root, "same.txt"),
    );
  });
});

describe("desktop entries", () => {
  it("reads only the main section, not an action's keys", async () => {
    // A `.desktop` file may carry several action groups with their own keys.
    // Reading the file flat would let an action's `Terminal=true` decide how
    // the MAIN command runs.
    const applications = join(root, "applications");
    await mkdir(applications, { recursive: true });
    await writeFile(
      join(applications, "thing.desktop"),
      "[Desktop Entry]\nName=Thing\nExec=thing %f\nTerminal=false\n\n[Desktop Action Edit]\nTerminal=true\nExec=vim %f\n",
    );

    const before = process.env["XDG_DATA_HOME"];
    process.env["XDG_DATA_HOME"] = root;
    process.env["XDG_DATA_DIRS"] = "";
    try {
      const keys = await desktopEntryKeys("thing.desktop");
      expect(keys.get("Terminal")).toBe("false");
      expect(keys.get("Exec")).toBe("thing %f");
    } finally {
      if (before === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = before;
    }
  });

  it("returns nothing for an entry that does not exist", async () => {
    expect((await desktopEntryKeys("nothing-here.desktop")).size).toBe(0);
  });
});
