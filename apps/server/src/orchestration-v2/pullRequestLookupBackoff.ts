/**
 * Mesura: the background pull-request sweep's backoff for thread groups whose
 * lookup failed for a cause a retry cannot change. Such a group is skipped by
 * periodic sweeps until its wait is over; the wait doubles per failure from one
 * minute up to an hour. Events that can change the answer (a finished run, a
 * checkpoint, a branch change) look the group up at once regardless, and a
 * success forgets the group. It also says when the next lookup must bypass a
 * failure GitManager cached, so an event or the next sweep reaches the provider.
 *
 * Kept out of `ThreadPullRequestService.ts`, an upstream file, so the upstream
 * diff stays a few lines.
 *
 * @module orchestration-v2/pullRequestLookupBackoff
 */
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/** Causes a provider reports when the server holds no usable credential. */
const AUTHENTICATION_FAILURE_TAGS = new Set([
  "GitHubApiAuthenticationError",
  "GitHubCliMissingError",
  "GitHubNotSignedInError",
  "GitHubHostDisabledError",
  "GitLabCliAuthenticationError",
]);

/** Causes a provider reports when it throttles the server. */
const RATE_LIMIT_TAGS = new Set([
  "GitHubApiRateLimitError",
  "SourceControlRateLimitPausedError",
  "GitLabCliRateLimitError",
]);

/** The registry's answer for a remote whose host no provider serves. */
const UNREGISTERED_PROVIDER_DETAIL = /^No \S+ source control provider is registered\.$/u;

interface TaggedNode {
  readonly _tag?: unknown;
  readonly detail?: unknown;
  readonly failureKind?: unknown;
  readonly reason?: unknown;
  readonly status?: unknown;
  readonly cause?: unknown;
}

export type LookupFailureKind = "permanent" | "rate-limited" | "transient";

/** The kind one error in a cause chain names, if it names one. */
function kindOfNode(node: TaggedNode): LookupFailureKind | null {
  if (
    node._tag === "SourceControlProviderError" &&
    typeof node.detail === "string" &&
    UNREGISTERED_PROVIDER_DETAIL.test(node.detail)
  ) {
    return "permanent";
  }
  if (typeof node._tag === "string" && AUTHENTICATION_FAILURE_TAGS.has(node._tag)) {
    return "permanent";
  }
  if (typeof node._tag === "string" && RATE_LIMIT_TAGS.has(node._tag)) return "rate-limited";
  switch (node._tag) {
    case "VcsProcessExitError":
      if (node.failureKind === "authentication") return "permanent";
      if (node.failureKind === "rate-limited") return "rate-limited";
      return null;
    // `forbidden` is a credential without access, which a grant can fix: transient.
    case "ForgejoCliError":
      if (node.reason === "authentication") return "permanent";
      if (node.reason === "rate-limit") return "rate-limited";
      return null;
    case "BitbucketResponseError":
      if (node.status === 401) return "permanent";
      if (node.status === 429) return "rate-limited";
      return null;
    default:
      return null;
  }
}

/**
 * What a lookup failure is: permanent when a retry cannot change it (no
 * provider serves the remote, or the provider has no usable credential),
 * rate-limited when the provider throttled the server, transient otherwise
 * (timeouts, network errors, forbidden answers).
 */
export function classifyLookupFailure(cause: Cause.Cause<unknown>): LookupFailureKind {
  const failure = Cause.findError(cause);
  if (!Result.isSuccess(failure)) return "transient";
  let node: unknown = failure.success;
  // Provider errors wrap the tool's error in `cause`; a few levels cover every provider.
  for (let depth = 0; depth < 6 && typeof node === "object" && node !== null; depth += 1) {
    const kind = kindOfNode(node);
    if (kind !== null) return kind;
    node = (node as TaggedNode).cause;
  }
  return "transient";
}

/** The wait after `failures` consecutive permanent failures. */
export function lookupBackoffDelayMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

export interface PullRequestLookupBackoff {
  /** Whether a periodic sweep should skip the group at `now`. */
  readonly isWaiting: (groupKey: string, now: number) => boolean;
  /**
   * Whether the group's next lookup must bypass a failure GitManager cached:
   * after a permanent failure (the wait is the sweep's to decide) and after a
   * transient one (retried on the next sweep). A rate limit keeps GitManager's
   * own backoff.
   */
  readonly retriesCachedFailure: (groupKey: string) => boolean;
  readonly recordFailure: (groupKey: string, kind: LookupFailureKind, now: number) => void;
  readonly forget: (groupKey: string) => void;
  /** Drops groups a full sweep no longer sees, so the table cannot grow without bound. */
  readonly retainOnly: (groupKeys: ReadonlySet<string>) => void;
}

export function makePullRequestLookupBackoff(): PullRequestLookupBackoff {
  const groups = new Map<
    string,
    { readonly kind: LookupFailureKind; readonly failures: number; readonly retryAt: number }
  >();
  return {
    isWaiting: (groupKey, now) => {
      const group = groups.get(groupKey);
      return group?.kind === "permanent" && group.retryAt > now;
    },
    retriesCachedFailure: (groupKey) => {
      const kind = groups.get(groupKey)?.kind;
      return kind === "permanent" || kind === "transient";
    },
    recordFailure: (groupKey, kind, now) => {
      const previous = groups.get(groupKey);
      const failures = kind === "permanent" ? (previous?.failures ?? 0) + 1 : 0;
      groups.set(groupKey, {
        kind,
        failures,
        retryAt: kind === "permanent" ? now + lookupBackoffDelayMs(failures) : now,
      });
    },
    forget: (groupKey) => {
      groups.delete(groupKey);
    },
    retainOnly: (groupKeys) => {
      for (const groupKey of groups.keys()) if (!groupKeys.has(groupKey)) groups.delete(groupKey);
    },
  };
}
