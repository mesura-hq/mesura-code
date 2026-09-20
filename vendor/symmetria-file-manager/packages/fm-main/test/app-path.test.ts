import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { containedRealPath, resolveWithinRoot } from "../src/appPath.ts";

const ROOT = "/srv/app/renderer";

/**
 * The containment guard on the custom scheme's request handler.
 *
 * Serving the renderer from its own scheme is what closed the `file://` read
 * that verification found. That fix is only worth anything if the handler
 * cannot be walked back out of its root — otherwise
 * `symmetria-fm://app/../../etc/passwd` is the same hole in a new costume.
 */
describe("resolveWithinRoot", () => {
  it("resolves an ordinary asset inside the root", () => {
    expect(resolveWithinRoot(ROOT, "/index.html")).toBe(`${ROOT}/index.html`);
    expect(resolveWithinRoot(ROOT, "/assets/index-abc.js")).toBe(`${ROOT}/assets/index-abc.js`);
  });

  it("serves the entry document for the bare root", () => {
    expect(resolveWithinRoot(ROOT, "/")).toBe(`${ROOT}/index.html`);
  });

  it("refuses to climb out of the root", () => {
    expect(resolveWithinRoot(ROOT, "/../../etc/passwd")).toBeNull();
    expect(resolveWithinRoot(ROOT, "/assets/../../../etc/passwd")).toBeNull();
  });

  it("refuses a climb hidden behind percent-encoding", () => {
    // `%2e%2e%2f` is `../`. Decoding happens before normalisation, so a guard
    // that checked the raw string would pass this straight through.
    expect(resolveWithinRoot(ROOT, "/%2e%2e%2f%2e%2e%2fetc/passwd")).toBeNull();
  });

  it("refuses a sibling directory that merely shares the root's prefix", () => {
    // `/srv/app/renderer-evil` starts with the root string but is not inside
    // it. A `startsWith` check without a separator would accept it.
    expect(resolveWithinRoot("/srv/app/renderer", "/../renderer-evil/x.js")).toBeNull();
  });
});

/**
 * Guards for the two defects the review found in `resolveWithinRoot` and its
 * caller. Both are the same failure the custom scheme exists to prevent,
 * reached by a different door.
 */
describe("containedRealPath", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), "symfm-path-"));
    root = join(base, "renderer");
    outside = join(base, "secret");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html>");
    await writeFile(join(outside, "passwd"), "root:x:0:0");
  });

  afterEach(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  it("serves an ordinary file inside the root", async () => {
    await expect(containedRealPath(root, "/index.html")).resolves.toBe(
      await realpath(join(root, "index.html")),
    );
  });

  it("refuses a symlink that points out of the root", async () => {
    // The defect: `resolveWithinRoot` is string arithmetic and never touches
    // the disk, so a planted symlink passes its prefix check and the operating
    // system then follows it on read. Only a realpath comparison catches this.
    await symlink(join(outside, "passwd"), join(root, "escape.txt"));

    await expect(containedRealPath(root, "/escape.txt")).resolves.toBeNull();
  });

  it("allows a symlink that stays inside the root", async () => {
    await writeFile(join(root, "real.js"), "export {};");
    await symlink(join(root, "real.js"), join(root, "alias.js"));

    await expect(containedRealPath(root, "/alias.js")).resolves.toBe(
      await realpath(join(root, "real.js")),
    );
  });

  it("returns null for a file that does not exist, rather than throwing", async () => {
    await expect(containedRealPath(root, "/nope.js")).resolves.toBeNull();
  });
});

describe("resolveWithinRoot, malformed input", () => {
  it("rejects a malformed percent-sequence instead of throwing", () => {
    // `decodeURIComponent("%")` throws a URIError. Unguarded, that escaped the
    // handler as an opaque network error instead of the intended fail-closed
    // reply — an undocumented path on the one function whose job is to fail
    // closed.
    expect(() => resolveWithinRoot(ROOT, "/%")).not.toThrow();
    expect(resolveWithinRoot(ROOT, "/%")).toBeNull();
    expect(resolveWithinRoot(ROOT, "/%E0%80%80")).toBeNull();
  });

  it("rejects a path carrying a NUL byte", () => {
    // A NUL terminates the path at the syscall boundary, so a string check can
    // approve one thing and the kernel open another.
    expect(resolveWithinRoot(ROOT, "/index.html%00/../../etc/passwd")).toBeNull();
  });
});
