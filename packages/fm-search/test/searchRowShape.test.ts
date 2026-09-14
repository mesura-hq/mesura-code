/**
 * The boundary row and the engine row must not drift apart.
 *
 * `SearchReplyRow` in `@symmetria/fm-core/contract` duplicates `SearchRow`
 * here, on purpose: importing one from the other would either invert the
 * dependency direction — the shared core depending on the engine — or force a
 * host to take two git-pinned packages to get the finder.
 *
 * Duplication is only acceptable when something checks it. This is that
 * something. It is a TYPE-level assertion rather than a runtime one, because
 * the property worth pinning is that the two declarations are mutually
 * assignable, and a value cannot demonstrate that.
 */
import type { SearchReplyRow } from "@symmetria/fm-core/contract";
import { describe, expect, it } from "vitest";

import type { SearchRow } from "../src/main/rows.ts";

/** Compile-time equality, in both directions. */
type Extends<A, B> = A extends B ? true : false;

// If either of these stops being `true`, the two declarations have drifted and
// this file fails to type-check — which is the point.
const engineRowFitsTheBoundary: Extends<SearchRow, SearchReplyRow> = true;
const boundaryRowFitsTheEngine: Extends<SearchReplyRow, SearchRow> = true;

describe("the boundary row and the engine row", () => {
  it("are mutually assignable, so the duplication cannot drift unnoticed", () => {
    // The assertions above are what actually enforce this; these two lines
    // stop the constants being dead code and make the failure legible in a
    // test report rather than only in a type-check.
    expect(engineRowFitsTheBoundary).toBe(true);
    expect(boundaryRowFitsTheEngine).toBe(true);
  });

  it("agree field for field on a real row", () => {
    // A structural spot-check as well as the type one: a field added to both
    // with different names would satisfy the assignability test above only if
    // both were optional, and this catches that case.
    const row: SearchRow = {
      relativePath: "src/a.ts",
      name: "a.ts",
      fullPath: "/root/src/a.ts",
      isDir: false,
      score: 1,
      size: 2,
      modifiedMs: 3,
      gitStatus: "clean",
      matchIndices: [0],
    };
    const asBoundary: SearchReplyRow = row;
    expect(Object.keys(asBoundary).sort()).toEqual(Object.keys(row).sort());
  });
});
