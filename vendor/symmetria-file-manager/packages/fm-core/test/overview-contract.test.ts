import { expect, it } from "vitest";
import { decodeOverviewReply, decodeOverviewRequest } from "../src/overview/contract.ts";

const entry = { name: "folder", kind: "directory", isSymlink: false, isHidden: false };
it("rejects invalid reply entries, duplicates and counts", () => {
  for (const name of ["", ".", "..", "a/b", "a\0b"])
    expect(
      decodeOverviewReply({ entries: [{ ...entry, name }], inspected: 1, truncated: false }).ok,
    ).toBe(false);
  for (const entries of [
    [entry, entry],
    [{ ...entry, kind: "unknown" }],
    [{ ...entry, isHidden: 0 }],
  ])
    expect(decodeOverviewReply({ entries, inspected: 2, truncated: false }).ok).toBe(false);
  expect(decodeOverviewReply({ entries: [entry], inspected: 0, truncated: false }).ok).toBe(false);
  expect(decodeOverviewReply({ entries: [entry], inspected: 1, truncated: false }).ok).toBe(true);
});
it("rejects non-integer and out-of-budget inspection limits", () => {
  for (const limit of [0, -1, 1.5, 1001, NaN, Infinity, "10"])
    expect(decodeOverviewRequest({ path: "/", requestId: "overview:1", limit }).ok).toBe(false);
});
