/**
 * Mesura: runs `gh` for issue reads, behind the server's process runner. Upstream's
 * GitHub API services replaced its `gh` wrapper and carry no issue reads.
 * @module GitHubIssueCli
 */
import { type VcsError, type VcsProcessExitFailureKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const GitHubIssueCliFailure = Schema.Literals([
  "unavailable",
  ...([
    "authentication",
    "not-found",
    "rate-limited",
    "command-failed",
  ] as const satisfies ReadonlyArray<VcsProcessExitFailureKind>),
]);
type GitHubIssueCliFailure = typeof GitHubIssueCliFailure.Type;

export class GitHubIssueCliError extends Schema.TaggedError<GitHubIssueCliError>()(
  "GitHubIssueCliError",
  {
    failure: GitHubIssueCliFailure,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.failure) {
      case "unavailable":
        return "GitHub CLI (`gh`) is required but not available on PATH.";
      case "authentication":
        return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
      case "rate-limited":
        return "GitHub API rate limit exceeded. Run `gh api rate_limit` to inspect the quota and reset time.";
      case "not-found":
        return "GitHub could not find that issue or repository.";
      case "command-failed":
        return "GitHub CLI command failed.";
    }
  }

  static fromVcsError(error: VcsError): GitHubIssueCliError {
    if (
      error._tag === "VcsProcessSpawnError" &&
      error.cause instanceof PlatformError.PlatformError &&
      error.cause.reason._tag === "NotFound"
    ) {
      return new GitHubIssueCliError({ failure: "unavailable", cause: error });
    }
    if (error._tag === "VcsProcessExitError") {
      return new GitHubIssueCliError({
        failure: error.failureKind ?? "command-failed",
        cause: error,
      });
    }
    return new GitHubIssueCliError({ failure: "command-failed", cause: error });
  }
}

export class GitHubIssueCli extends Context.Service<
  GitHubIssueCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubIssueCliError>;
  }
>()("t3/issues/GitHubIssueCli") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const execute: GitHubIssueCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "GitHubIssueCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(Effect.mapError(GitHubIssueCliError.fromVcsError));
  return GitHubIssueCli.of({ execute });
});

export const layer = Layer.effect(GitHubIssueCli, make).pipe(Layer.provide(VcsProcess.layer));
