import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  authorisePreview,
  authorisePreviewDirectory,
  forgetPreviewTokens,
  resolveDirectoryToken,
  resolvePreviewDirectoryPath,
  resolveToken,
} from "../src/previewTokens.ts";

/**
 * The capability registry behind the preview URLs.
 *
 * It exists because Chromium's PDF viewer refuses a blob URL whose origin is a
 * custom scheme; what it must get right is that only paths the main process
 * handed out are reachable, and that a resident session does not accumulate
 * them without bound.
 */

afterEach(forgetPreviewTokens);

describe("authorisePreview", () => {
  it("makes a path reachable by the token it returns", () => {
    const token = authorisePreview("/tmp/photo.png");

    expect(resolveToken(token)).toBe("/tmp/photo.png");
  });

  it("returns the same token for a path already authorised", () => {
    // A component that re-renders must not leak a token per render.
    expect(authorisePreview("/tmp/a.png")).toBe(authorisePreview("/tmp/a.png"));
  });

  it("gives different paths different tokens", () => {
    expect(authorisePreview("/tmp/a.png")).not.toBe(authorisePreview("/tmp/b.png"));
  });

  it("reaches nothing that was never authorised", () => {
    // The whole point: this route serves exactly what the main process handed
    // out, so a guessed token is not a way into the filesystem.
    expect(resolveToken("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("evicts the oldest rather than growing without bound", () => {
    // A resident application previews thousands of files in a session, and an
    // unbounded map would keep every one of them addressable for the lifetime
    // of the process.
    const first = authorisePreview("/tmp/file-0");
    for (let i = 1; i <= 64; i++) authorisePreview(`/tmp/file-${i}`);

    expect(resolveToken(first)).toBeNull();
  });

  it("keeps the most recent authorisations", () => {
    for (let i = 0; i <= 64; i++) authorisePreview(`/tmp/file-${i}`);

    expect(resolveToken(authorisePreview("/tmp/file-64"))).toBe("/tmp/file-64");
  });
});

/**
 * A grant over a DIRECTORY, for a document's own neighbours.
 *
 * The file grant above deliberately narrows nothing — its header says so. This
 * one is the opposite: it names a root and refuses everything outside it, once
 * symbolic links are followed. It exists because a rendered document
 * references its own images and stylesheets by relative path, and the file
 * grant cannot serve them: a relative reference resolves against the token URL
 * and finds nothing there.
 */
describe("a directory grant", () => {
  let root: string;
  let inside: string;
  let elsewhere: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "fm-dir-grant-")));
    inside = join(root, "document");
    elsewhere = join(root, "elsewhere");
    mkdirSync(join(inside, "assets"), { recursive: true });
    mkdirSync(elsewhere, { recursive: true });

    writeFileSync(join(inside, "README.md"), "# hello\n");
    writeFileSync(join(inside, "assets", "flow.png"), "not really a png");
    writeFileSync(join(elsewhere, "secret.txt"), "should never be served");
    // A link planted INSIDE the granted directory, pointing out of it. String
    // arithmetic alone accepts this; resolving both sides to their real path
    // is what refuses it.
    symlinkSync(join(elsewhere, "secret.txt"), join(inside, "escape.txt"));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a relative path inside it to that file's real path", async () => {
    const token = authorisePreviewDirectory(inside);

    await expect(resolvePreviewDirectoryPath(token, "assets/flow.png")).resolves.toBe(
      join(inside, "assets", "flow.png"),
    );
  });

  it("refuses a path that climbs out with .., called directly", async () => {
    // "called directly" is not padding. Measured against a real Electron:
    // Chromium collapses an unencoded `../` before the request leaves the
    // process, so over live traffic this shape never reaches this function at
    // all — it lands on the asset route and is refused there by its own
    // containment check. The encoded form below is the one that arrives here.
    const token = authorisePreviewDirectory(inside);

    await expect(resolvePreviewDirectoryPath(token, "../elsewhere/secret.txt")).resolves.toBeNull();
  });

  it("refuses the percent-encoded climb, which is what a browser really sends", async () => {
    const token = authorisePreviewDirectory(inside);

    await expect(
      resolvePreviewDirectoryPath(token, "%2e%2e%2felsewhere%2fsecret.txt"),
    ).resolves.toBeNull();
  });

  it("refuses a directory, rather than answering 200 and then failing", async () => {
    // `assets` passes containment and stats fine. Handing it to a read stream
    // raises EISDIR after the status and headers have already gone out, so the
    // client sees a broken success instead of a clean refusal.
    const token = authorisePreviewDirectory(inside);

    await expect(resolvePreviewDirectoryPath(token, "assets")).resolves.toBeNull();
  });

  it("refuses a symbolic link inside it that points outside it", async () => {
    // The one an escape check made of string arithmetic gets wrong, and the
    // reason `containedRealPath` resolves both sides before comparing.
    const token = authorisePreviewDirectory(inside);

    await expect(resolvePreviewDirectoryPath(token, "escape.txt")).resolves.toBeNull();
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a path under another root", "/tmp"],
    ["something naming a scheme", "https://example.com/tracker.png"],
    ["a protocol-relative address", "//example.com/tracker.png"],
  ])("refuses %s", async (_why, requested) => {
    const token = authorisePreviewDirectory(inside);

    await expect(resolvePreviewDirectoryPath(token, requested)).resolves.toBeNull();
  });

  it("returns the same token for a directory already granted", () => {
    // A re-render must not issue a second grant, for the same reason the file
    // grant reuses its token: the bound is small and a leak per render eats it.
    expect(authorisePreviewDirectory(inside)).toBe(authorisePreviewDirectory(inside));
  });

  it("resolves nothing for a token that was never issued", async () => {
    expect(resolveDirectoryToken("00000000-0000-0000-0000-000000000000")).toBeNull();
    await expect(
      resolvePreviewDirectoryPath("00000000-0000-0000-0000-000000000000", "README.md"),
    ).resolves.toBeNull();
  });

  it("keeps the two kinds of grant apart", async () => {
    // A file token must never resolve as a directory root, or a grant over one
    // file would quietly become a grant over its whole directory.
    const file = authorisePreview(join(inside, "README.md"));
    const directory = authorisePreviewDirectory(inside);

    expect(resolveDirectoryToken(file)).toBeNull();
    expect(resolveToken(directory)).toBeNull();
  });

  it("forgets both kinds when the registry is cleared", async () => {
    const token = authorisePreviewDirectory(inside);
    forgetPreviewTokens();

    await expect(resolvePreviewDirectoryPath(token, "README.md")).resolves.toBeNull();
  });
});
