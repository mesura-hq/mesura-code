import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { IssueDetail, IssueListInput } from "./issues.ts";

const decodeListInput = Schema.decodeUnknownExit(IssueListInput);
const decodeDetail = Schema.decodeUnknownSync(IssueDetail);

const listInput = { projectId: "project-1", state: "open", query: "", limit: 50 } as const;

describe("IssueListInput bounds", () => {
  it("accepts issue list pages from one to five hundred summaries", () => {
    expect(decodeListInput({ ...listInput, limit: 1 })._tag).toBe("Success");
    expect(decodeListInput({ ...listInput, limit: 500 })._tag).toBe("Success");
  });

  it("rejects issue list pages outside one to five hundred summaries", () => {
    expect(decodeListInput({ ...listInput, limit: 0 })._tag).toBe("Failure");
    expect(decodeListInput({ ...listInput, limit: 501 })._tag).toBe("Failure");
    expect(decodeListInput({ ...listInput, limit: 1.5 })._tag).toBe("Failure");
  });

  it("rejects an issue search query longer than five hundred characters", () => {
    expect(decodeListInput({ ...listInput, query: "a".repeat(500) })._tag).toBe("Success");
    expect(decodeListInput({ ...listInput, query: "a".repeat(501) })._tag).toBe("Failure");
  });
});

describe("IssueDetail deleted authors", () => {
  // `gh` reports a deleted account as a null author or, through its Go structs, as an empty
  // login. Both reach the client without failing the whole detail read.
  it("decodes an issue detail whose issue and comment authors were deleted", () => {
    const detail = decodeDetail({
      number: 7,
      title: "Orphaned report",
      url: "https://github.com/acme/app/issues/7",
      state: "CLOSED",
      author: { id: "", is_bot: false, login: "", name: "" },
      assignees: [],
      labels: [],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      body: "",
      comments: [
        {
          id: "IC_1",
          author: null,
          authorAssociation: "NONE",
          body: "Gone",
          createdAt: "2026-10-01T00:00:00Z",
          url: "https://github.com/acme/app/issues/7#issuecomment-1",
        },
        {
          id: "IC_2",
          author: { login: "ghost" },
          body: "Also gone",
          createdAt: "2026-10-01T00:00:00Z",
          url: "https://github.com/acme/app/issues/7#issuecomment-2",
        },
      ],
    });
    expect(detail.author).toEqual({ login: "" });
    expect(detail.comments.map((comment) => comment.author)).toEqual([null, { login: "ghost" }]);
  });
});
