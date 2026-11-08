/**
 * Issues pane, phase 3 fence: the pure decisions behind following an issue reference — which
 * URLs name an issue, which registered project may read it, and which clicks stay ordinary links.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForIssueLink,
  issuesSurfaceProject,
  parseIssueUrl,
  shouldInterceptIssueLinkClick,
} from "./openIssueLink";

const threadEnvironmentId = EnvironmentId.make("issue-link-thread-env");
const otherEnvironmentId = EnvironmentId.make("issue-link-other-env");

function project(
  environmentId: EnvironmentId,
  id: string,
  identity: Record<string, unknown> | null,
): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: identity,
  } as unknown as EnvironmentProject;
}

const upstream = project(threadEnvironmentId, "upstream", {
  // The measured shape: a known GitHub identity with no web URL, read from the `upstream` remote.
  canonicalKey: "github.com/pingdotgg/t3code",
  provider: "github",
  owner: "pingdotgg",
  name: "t3code",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "git@github.com:pingdotgg/t3code.git",
  },
});
const fork = project(threadEnvironmentId, "fork", {
  canonicalKey: "github.com/mesura-hq/mesura-code",
  provider: "github",
  owner: "mesura-hq",
  name: "mesura-code",
  webUrl: "https://github.com/mesura-hq/mesura-code",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
});
const sameRepositoryElsewhere = project(otherEnvironmentId, "elsewhere", {
  canonicalKey: "github.com/acme/zeta",
  provider: "github",
  owner: "acme",
  name: "zeta",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
});
const gitlab = project(threadEnvironmentId, "gitlab", {
  canonicalKey: "gitlab.com/acme/alpha",
  provider: "gitlab",
  owner: "acme",
  name: "alpha",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
});

describe("parseIssueUrl (issues phase 3 fence)", () => {
  it("issues phase 3 fence: reads a GitHub issue URL with or without trailing segments", () => {
    expect(parseIssueUrl("https://github.com/pingdotgg/t3code/issues/17402")).toMatchObject({
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 17402,
    });
    for (const url of [
      "https://github.com/PingDotGG/T3Code/issues/17402/",
      "https://github.com/pingdotgg/t3code/issues/17402?q=1",
      "https://github.com/pingdotgg/t3code/issues/17402#issuecomment-1",
    ]) {
      expect(parseIssueUrl(url)).toMatchObject({ repository: "pingdotgg/t3code", number: 17402 });
    }
  });

  it("issues phase 3 fence: claims nothing that is not one issue on a GitHub host", () => {
    for (const url of [
      "https://github.com/pingdotgg/t3code/pull/17404",
      "https://github.com/pingdotgg/t3code/issues",
      "https://github.com/pingdotgg/t3code/issues/new",
      "https://github.com/pingdotgg/t3code/issues/0",
      "https://github.com/pingdotgg/t3code/issues/-3",
      "https://github.com/pingdotgg/t3code/issues/1.5",
      "https://github.com/pingdotgg/t3code/issues/99999999999999999999",
      "https://github.com/pingdotgg/issues/7",
      "https://gitlab.com/acme/alpha/-/issues/7",
      "https://example.com/pingdotgg/t3code/issues/7",
      "javascript:alert(1)//github.com/a/b/issues/7",
      "#7",
      "not a url",
    ]) {
      expect(parseIssueUrl(url), url).toBeNull();
    }
  });
});

describe("findProjectForIssueLink (issues phase 3 fence)", () => {
  const projects = [upstream, fork, sameRepositoryElsewhere, gitlab];

  it("issues phase 3 fence: matches the exact registered repository on the thread's environment", () => {
    expect(
      findProjectForIssueLink(
        projects,
        threadEnvironmentId,
        parseIssueUrl("https://github.com/pingdotgg/t3code/issues/17402")!,
      ),
    ).toBe(upstream);
    expect(
      findProjectForIssueLink(
        projects,
        threadEnvironmentId,
        parseIssueUrl("https://github.com/mesura-hq/mesura-code/issues/3")!,
      ),
    ).toBe(fork);
  });

  it("issues phase 3 fence: never borrows another project on the same host for an unrelated repository", () => {
    expect(
      findProjectForIssueLink(
        projects,
        threadEnvironmentId,
        parseIssueUrl("https://github.com/cli/cli/issues/7")!,
      ),
    ).toBeUndefined();
  });

  it("issues phase 3 fence: never picks a project on another environment because its repository matches", () => {
    expect(
      findProjectForIssueLink(
        projects,
        threadEnvironmentId,
        parseIssueUrl("https://github.com/acme/zeta/issues/7")!,
      ),
    ).toBeUndefined();
    expect(
      findProjectForIssueLink(
        projects,
        otherEnvironmentId,
        parseIssueUrl("https://github.com/acme/zeta/issues/7")!,
      ),
    ).toBe(sameRepositoryElsewhere);
  });

  it("issues phase 3 fence: keeps an Enterprise host, a lookalike host and other providers apart", () => {
    for (const url of [
      "https://github.acme.test/pingdotgg/t3code/issues/7",
      "https://github.com-evil.test/pingdotgg/t3code/issues/7",
    ]) {
      const link = parseIssueUrl(url);
      expect(
        link === null ? undefined : findProjectForIssueLink(projects, threadEnvironmentId, link),
        url,
      ).toBeUndefined();
    }
    expect(
      findProjectForIssueLink([gitlab], threadEnvironmentId, {
        host: "gitlab.com",
        repository: "acme/alpha",
        number: 7,
        repositoryUrl: "https://gitlab.com/acme/alpha",
      }),
    ).toBeUndefined();
  });

  it("issues phase 3 fence: a project without a recorded identity claims no issue link", () => {
    const unknown = project(threadEnvironmentId, "unknown", null);
    expect(
      findProjectForIssueLink(
        [unknown],
        threadEnvironmentId,
        parseIssueUrl("https://github.com/pingdotgg/t3code/issues/7")!,
      ),
    ).toBeUndefined();
  });
});

describe("shouldInterceptIssueLinkClick (issues phase 3 fence)", () => {
  const plain = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };

  it("issues phase 3 fence: an ordinary primary click or keyboard activation is followed in the app", () => {
    expect(shouldInterceptIssueLinkClick(plain)).toBe(true);
  });

  it("issues phase 3 fence: every modifier and every non-primary button keeps the ordinary link", () => {
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(shouldInterceptIssueLinkClick({ ...plain, [modifier]: true }), modifier).toBe(false);
    }
    expect(shouldInterceptIssueLinkClick({ ...plain, button: 1 })).toBe(false);
  });
});

describe("issuesSurfaceProject (issues phase 3 fence)", () => {
  const projects = [upstream, fork, sameRepositoryElsewhere];

  it("issues phase 3 fence: a selection opens its own project on the thread's environment", () => {
    expect(
      issuesSurfaceProject({
        selection: { projectId: fork.id, number: 3, requestId: 1 },
        environmentId: threadEnvironmentId,
        projects,
        activeProject: upstream,
      }),
    ).toBe(fork);
  });

  it("issues phase 3 guard: a surface without a selection keeps the thread's current project", () => {
    expect(
      issuesSurfaceProject({
        selection: undefined,
        environmentId: threadEnvironmentId,
        projects,
        activeProject: upstream,
      }),
    ).toBe(upstream);
  });

  it("issues phase 3 fence: a selection whose project is not on the thread's environment is not replaced by another", () => {
    expect(
      issuesSurfaceProject({
        selection: { projectId: sameRepositoryElsewhere.id, number: 3, requestId: 1 },
        environmentId: threadEnvironmentId,
        projects,
        activeProject: upstream,
      }),
    ).toBeNull();
  });
});

describe("findProjectForIssueLink with partial or contradictory identities (issues phase 3 repair)", () => {
  const locator = { source: "git-remote", remoteName: "upstream", remoteUrl: "x" };
  const canonicalOnly = project(threadEnvironmentId, "canonical-only", {
    canonicalKey: "github.com/pingdotgg/t3code",
    provider: "github",
    locator,
  });
  const contradictory = project(threadEnvironmentId, "contradictory", {
    canonicalKey: "github.com/pingdotgg/t3code",
    provider: "github",
    owner: "mesura-hq",
    name: "mesura-code",
    locator,
  });

  it("issues phase 3 repair: a canonical-only GitHub identity claims its own issue links", () => {
    expect(
      findProjectForIssueLink(
        [canonicalOnly],
        threadEnvironmentId,
        parseIssueUrl("https://github.com/pingdotgg/t3code/issues/17402")!,
      ),
    ).toBe(canonicalOnly);
  });

  it("issues phase 3 repair: an identity naming two repositories claims neither repository's links", () => {
    for (const url of [
      "https://github.com/pingdotgg/t3code/issues/17402",
      "https://github.com/mesura-hq/mesura-code/issues/3",
    ]) {
      expect(
        findProjectForIssueLink([contradictory], threadEnvironmentId, parseIssueUrl(url)!),
        url,
      ).toBeUndefined();
    }
  });
});
