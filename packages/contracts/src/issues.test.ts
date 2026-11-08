import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  IssueDetail,
  IssueListInput,
  IssueReference,
  IssueReferenceInput,
  issueRepositoryUrl,
} from "./issues.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

const decodeListInput = Schema.decodeUnknownExit(IssueListInput);
const decodeDetail = Schema.decodeUnknownSync(IssueDetail);

const decodeReferenceInput = Schema.decodeUnknownExit(IssueReferenceInput);
const decodeReference = Schema.decodeUnknownExit(IssueReference);

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

describe("Issue reference resolution contract (issues phase 3 fence)", () => {
  it("issues phase 3 fence: a reference names a project and a positive whole number, nothing else", () => {
    expect(decodeReferenceInput({ projectId: "project-1", number: 17402 })._tag).toBe("Success");
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decodeReferenceInput({ projectId: "project-1", number })._tag).toBe("Failure");
    }
  });

  it("issues phase 3 fence: a resolved reference is exactly an issue or a pull request with its canonical URL", () => {
    const issue = {
      kind: "issue",
      number: 17402,
      url: "https://github.com/pingdotgg/t3code/issues/17402",
      repository: "pingdotgg/t3code",
    };
    expect(decodeReference(issue)._tag).toBe("Success");
    expect(
      decodeReference({
        ...issue,
        kind: "pull-request",
        number: 17404,
        url: "https://github.com/pingdotgg/t3code/pull/17404",
      })._tag,
    ).toBe("Success");
    expect(decodeReference({ ...issue, kind: "discussion" })._tag).toBe("Failure");
    expect(decodeReference({ ...issue, url: undefined })._tag).toBe("Failure");
  });
});

describe("issueRepositoryUrl, the repository a recorded identity names (issues phase 3 regression)", () => {
  const locator = { source: "git-remote", remoteName: "origin", remoteUrl: "x" } as const;

  it("issues phase 3 regression: a canonical-only identity on an Enterprise host names that host", () => {
    expect(
      issueRepositoryUrl({
        canonicalKey: "github.acme.test/platform/api",
        provider: SourceControlProviderKind.make("github"),
        locator,
      }),
    ).toBe("https://github.acme.test/platform/api");
  });

  it("issues phase 3 regression: a web URL that differs only by case, .git or a trailing slash agrees with the canonical key", () => {
    for (const webUrl of [
      "https://github.com/PingDotGG/T3Code",
      "https://github.com/pingdotgg/t3code.git",
      "https://github.com/pingdotgg/t3code/",
    ]) {
      expect(
        issueRepositoryUrl({
          canonicalKey: "github.com/pingdotgg/t3code",
          provider: SourceControlProviderKind.make("github"),
          webUrl,
          owner: "pingdotgg",
          name: "t3code",
          locator,
        }),
        webUrl,
      ).toBe(webUrl);
    }
  });

  it("issues phase 3 regression: another provider or a web URL that is not a web address names no GitHub repository", () => {
    expect(
      issueRepositoryUrl({
        canonicalKey: "gitlab.com/acme/alpha",
        provider: SourceControlProviderKind.make("gitlab"),
        locator,
      }),
    ).toBeNull();
    expect(
      issueRepositoryUrl({
        canonicalKey: "github.com/acme/alpha",
        provider: SourceControlProviderKind.make("github"),
        webUrl: "ssh://github.com/acme/alpha",
        locator,
      }),
    ).toBeNull();
    expect(
      issueRepositoryUrl({
        canonicalKey: "github.com/acme/alpha/extra",
        provider: SourceControlProviderKind.make("github"),
        locator,
      }),
    ).toBeNull();
  });
});
