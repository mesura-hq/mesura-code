import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LISTING_OPTIONS } from "@symmetria/fm-core/listingOptions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listingOptionsFilePath,
  loadListingOptions,
  saveListingOptions,
} from "../src/listingOptions.ts";

/**
 * Where the listing order lives, and what happens when the disk disagrees.
 *
 * Every case runs against a temporary directory. The path is a PARAMETER for
 * that reason: a module that derived it at import time would make every test
 * read or write the operator's real configuration.
 */

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "symfm-listing-"));
  path = join(dir, "listing.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("where the file lives", () => {
  it("sits beside the bookmarks, under the same configuration directory", () => {
    expect(listingOptionsFilePath({ home: "/home/someone" })).toBe(
      "/home/someone/.config/symmetria-fm/listing.json",
    );
  });

  it("is relocated by an explicit override", () => {
    // Two reasons, the same as the bookmark store's: a test must never touch
    // the operator's real configuration, and a user may want it elsewhere.
    expect(listingOptionsFilePath({ home: "/home/someone", override: "/tmp/x.json" })).toBe(
      "/tmp/x.json",
    );
  });
});

describe("loadListingOptions", () => {
  it("says NOTHING for a file that is not there", async () => {
    await expect(loadListingOptions(path)).resolves.toBeNull();
  });

  it("says UNREADABLE for a file that will not parse", async () => {
    await writeFile(path, "{ not json", "utf8");
    await expect(loadListingOptions(path)).resolves.toBe("unreadable");
  });

  it("says UNREADABLE for an empty file", async () => {
    // `JSON.parse("")` throws, so an empty file is a special case of the one
    // above rather than an empty set of options.
    await writeFile(path, "", "utf8");
    await expect(loadListingOptions(path)).resolves.toBe("unreadable");
  });

  it("says UNREADABLE for valid JSON that is not an options object", async () => {
    await writeFile(path, '["size"]', "utf8");
    await expect(loadListingOptions(path)).resolves.toBe("unreadable");
  });

  it("returns what a valid file said", async () => {
    // Three fields on disk, four in the answer. This is a file the PREVIOUS
    // cycle wrote, and the loader filling the key it never heard of is the
    // whole of what backward compatibility means here.
    await writeFile(path, '{"sort":"size","reverse":false,"showHidden":true}', "utf8");
    await expect(loadListingOptions(path)).resolves.toEqual({
      sort: "size",
      reverse: false,
      showHidden: true,
      renderDocuments: true,
    });
  });

  it("repairs a field the file got wrong rather than refusing the file", async () => {
    await writeFile(path, '{"sort":"size","reverse":"yes","showHidden":true}', "utf8");
    await expect(loadListingOptions(path)).resolves.toEqual({
      sort: "size",
      reverse: DEFAULT_LISTING_OPTIONS.reverse,
      showHidden: true,
      // A literal, not `DEFAULT_LISTING_OPTIONS.renderDocuments`: comparing a
      // field against the default it is filled from makes the assertion
      // co-vary with the thing it is checking.
      renderDocuments: true,
    });
  });
});

describe("saveListingOptions", () => {
  it("creates the directory it needs", async () => {
    const nested = join(dir, "a", "b", "listing.json");
    await saveListingOptions(nested, DEFAULT_LISTING_OPTIONS);

    await expect(readFile(nested, "utf8")).resolves.toContain('"sort"');
  });

  it("round-trips through the loader", async () => {
    const options = {
      sort: "natural",
      reverse: false,
      showHidden: true,
      renderDocuments: false,
    } as const;
    await saveListingOptions(path, options);

    await expect(loadListingOptions(path)).resolves.toEqual(options);
  });

  it("leaves no temporary file behind, because the rename IS the write", async () => {
    // Write-then-rename, because `rename` is the only atomic step. A
    // half-written file would be an unreadable one on the next start.
    await saveListingOptions(path, DEFAULT_LISTING_OPTIONS);

    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });

  it("writes a file a person can read and edit", async () => {
    await saveListingOptions(path, DEFAULT_LISTING_OPTIONS);
    const text = await readFile(path, "utf8");

    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);
  });
});
