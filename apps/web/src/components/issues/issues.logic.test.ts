import { describe, expect, it } from "vite-plus/test";

import { issuesAvailability, parseIssueSearch, projectIssuesAvailability } from "./issues.logic";

describe("issue navigation", () => {
  it("bounds URL input and rejects invalid issue numbers", () => {
    expect(
      parseIssueSearch({ issue: "-1", state: "invalid", limit: 10000, q: "x".repeat(600) }),
    ).toEqual({
      project: undefined,
      issue: undefined,
      state: "open",
      issueSort: "updated",
      limit: 500,
      q: "x".repeat(450),
    });
    expect(
      parseIssueSearch({
        issue: "42",
        state: "closed",
        issueSort: "created",
        project: "host:project",
      }).issue,
    ).toBe(42);
  });
});

/**
 * The shared availability decision the plan asks for: the thread pane, the standalone page and
 * every entry point read one answer from an environment's connection and its advertised
 * capabilities, so no caller can create an issue query that another caller would have refused.
 */
describe("issues availability decision", () => {
  const connected = (capabilities: Record<string, unknown> | null) =>
    ({
      connection: { phase: "connected" },
      serverConfig: capabilities === null ? null : { environment: { capabilities } },
    }) as unknown as Parameters<typeof issuesAvailability>[0];

  it("issues availability fence: only a connected environment advertising issues is available", () => {
    expect(issuesAvailability(connected({ issues: true }))).toBe("available");
  });

  it("issues availability fence: an older server without the capability is unsupported", () => {
    expect(issuesAvailability(connected({}))).toBe("unsupported");
    expect(issuesAvailability(connected({ issues: false }))).toBe("unsupported");
  });

  it("issues availability fence: an environment that has not reported its capabilities is still loading", () => {
    expect(issuesAvailability(connected(null))).toBe("loading");
  });

  it("issues availability fence: a supporting environment that is not connected is disconnected", () => {
    for (const phase of ["connecting", "reconnecting", "offline", "available", "error"]) {
      const environment = {
        connection: { phase },
        serverConfig: { environment: { capabilities: { issues: true } } },
      } as unknown as Parameters<typeof issuesAvailability>[0];
      expect(issuesAvailability(environment), phase).not.toBe("available");
    }
    expect(
      issuesAvailability({
        connection: { phase: "offline" },
        serverConfig: { environment: { capabilities: { issues: true } } },
      } as unknown as Parameters<typeof issuesAvailability>[0]),
    ).toBe("disconnected");
  });

  it("issues availability fence: an environment this client does not know is never available", () => {
    expect(issuesAvailability(null)).not.toBe("available");
  });
});

describe("project issues availability decision", () => {
  const supporting = {
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { issues: true } } },
  } as unknown as Parameters<typeof projectIssuesAvailability>[1];
  const older = {
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: {} } },
  } as unknown as Parameters<typeof projectIssuesAvailability>[1];
  const onProvider = (provider: string | null) =>
    ({
      repositoryIdentity: provider === null ? null : { provider },
    }) as unknown as Parameters<typeof projectIssuesAvailability>[0];

  it("issues availability rework: a project known to live off GitHub is never readable", () => {
    expect(projectIssuesAvailability(onProvider("gitlab"), supporting)).toBe("not-github");
    expect(projectIssuesAvailability(onProvider("gitlab"), older)).toBe("not-github");
  });

  it("issues availability rework: GitHub and not-yet-identified projects follow their server", () => {
    expect(projectIssuesAvailability(onProvider("github"), supporting)).toBe("available");
    expect(projectIssuesAvailability(onProvider(null), supporting)).toBe("available");
    expect(projectIssuesAvailability(onProvider(null), older)).toBe("unsupported");
  });
});
