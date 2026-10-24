import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GitWorkingTreeChangesResult } from "./gitChanges.ts";

describe("GitWorkingTreeChangesResult paths", () => {
  it("round-trips paths with surrounding whitespace byte for byte", () => {
    const result = {
      isRepo: true,
      repositoryRoot: "/repos/ends in space ",
      refName: "main",
      files: [
        {
          path: " spaced.txt ",
          originalPath: "\told name.txt ",
          index: "R",
          worktree: ".",
          staged: { insertions: 0, deletions: 0 },
          unstaged: { insertions: 0, deletions: 0 },
          binary: false,
        },
      ],
      truncated: false,
    } as const;
    const codec = Schema.toCodecJson(GitWorkingTreeChangesResult);
    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result));
    expect(decoded).toEqual(result);
  });
});
