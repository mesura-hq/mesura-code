import { describe, expect, it } from "vitest";
import {
  DEFAULT_LISTING_OPTIONS,
  decodeListingOptions,
  type ListingOptions,
  resolveListingOptions,
  type StoredListingOptions,
} from "../src/listingOptions.ts";

/**
 * What a stored listing order MEANS, apart from where it lives.
 *
 * The same division the bookmark store draws: this package decides what a
 * stored value means and what to do when it is nonsense, and `fm-main` owns the
 * file and what happens when the disk disagrees.
 */

describe("the default", () => {
  it("is modification time, newest first, hidden files off", () => {
    // The operator's words: "I would like to leave the default to be modified
    // in descending order. That is what I want to have in all places."
    // `modified` ascending is OLDEST first, so newest-first is that mode
    // reversed — which is why `reverse` is true and not a mistake.
    expect(DEFAULT_LISTING_OPTIONS).toEqual({
      sort: "modified",
      reverse: true,
      showHidden: false,
      renderDocuments: true,
    });
  });
});

describe("decodeListingOptions", () => {
  it("takes a whole, valid object as it stands", () => {
    expect(
      decodeListingOptions({
        sort: "size",
        reverse: false,
        showHidden: true,
        renderDocuments: false,
      }),
    ).toEqual({
      sort: "size",
      reverse: false,
      showHidden: true,
      renderDocuments: false,
    });
  });

  it.each([
    ["an unknown sort mode", { sort: "cromulent", reverse: false, showHidden: false }],
    ["a sort mode of the wrong type", { sort: 7, reverse: false, showHidden: false }],
    ["a missing sort mode", { reverse: false, showHidden: false }],
  ])("falls back to the default sort for %s", (_why, raw) => {
    expect(decodeListingOptions(raw).sort).toBe(DEFAULT_LISTING_OPTIONS.sort);
  });

  it("falls back FIELD BY FIELD, not file by file", () => {
    // A file with a good sort mode and a corrupt hidden flag keeps the sort
    // mode. Discarding the whole object would throw away a setting the user
    // did choose because of one they did not.
    const decoded = decodeListingOptions({ sort: "extension", reverse: "yes", showHidden: 3 });

    expect(decoded.sort).toBe("extension");
    expect(decoded.reverse).toBe(DEFAULT_LISTING_OPTIONS.reverse);
    expect(decoded.showHidden).toBe(DEFAULT_LISTING_OPTIONS.showHidden);
  });

  it("defaults a missing renderDocuments to on, keeping every stored field", () => {
    // A `listing.json` written before this key existed. Rendering is the
    // default, so an old file must come back with it on — and must not lose
    // the three settings the user did choose.
    const decoded = decodeListingOptions({ sort: "size", reverse: false, showHidden: true });

    expect(decoded).toEqual({
      sort: "size",
      reverse: false,
      showHidden: true,
      renderDocuments: true,
    });
  });

  it("repairs a corrupt renderDocuments alone", () => {
    const decoded = decodeListingOptions({
      sort: "natural",
      reverse: true,
      showHidden: true,
      renderDocuments: "yes",
    });

    // Pinned as `true` rather than as `DEFAULT_LISTING_OPTIONS.renderDocuments`.
    // Comparing against the default makes the assertion co-vary with the thing
    // it is checking: before the field existed BOTH sides were `undefined` and
    // the test passed while asserting nothing.
    expect(decoded.renderDocuments).toBe(true);
    expect(decoded.sort).toBe("natural");
    expect(decoded.reverse).toBe(true);
    expect(decoded.showHidden).toBe(true);
  });

  it("keeps a stored renderDocuments of false", () => {
    // The one that matters: rendering OFF is the only value the user can set
    // by hand, and a decoder that silently forced it back on would make the
    // whole setting look like it worked and forget every restart.
    expect(decodeListingOptions({ renderDocuments: false }).renderDocuments).toBe(false);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "sort=size"],
    ["undefined", undefined],
  ])("returns the whole default for %s", (_why, raw) => {
    expect(decodeListingOptions(raw)).toEqual(DEFAULT_LISTING_OPTIONS);
  });
});

describe("resolveListingOptions", () => {
  const stored: ListingOptions = {
    sort: "alphabetical",
    reverse: false,
    showHidden: true,
    renderDocuments: false,
  };

  it.each([
    ["no file at all — a first run", null, DEFAULT_LISTING_OPTIONS],
    ["a file that would not parse", "unreadable" as const, DEFAULT_LISTING_OPTIONS],
    ["a file that parsed", stored, stored],
  ])("uses the right options for %s", (_why, from: StoredListingOptions, expected) => {
    expect(resolveListingOptions(from).options).toEqual(expected);
  });

  it("never offers to overwrite a file it could not read", () => {
    // The user's own data, mid-edit. Neither trusted nor destroyed — which is
    // the whole reason "no file" and "bad file" are two answers and not one.
    expect(resolveListingOptions("unreadable").mayWrite).toBe(false);
    expect(resolveListingOptions(null).mayWrite).toBe(true);
    expect(resolveListingOptions(stored).mayWrite).toBe(true);
  });
});
