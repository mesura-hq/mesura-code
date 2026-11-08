/**
 * Pure projection of the fork's read model into the snapshot Symmetria Shell reads.
 * ⚠ Every field is built by name, never spread: an upstream thread does not decode as a summary
 * (`id` vs `threadId`, no `tokenUsage`), and a spread would publish whatever upstream adds next.
 * The input types are STRUCTURAL so the allowlist is visible: an absent field cannot be reached.
 */
import {
  SYMMETRIA_PROTOCOL_MAJOR,
  SYMMETRIA_PROTOCOL_MINOR,
  SymmetriaStreamSnapshot,
} from "@symmetria/broker-contract";

/**
 * Builds the ENCODED form: the decoded `SymmetriaStreamSnapshot` has branded identifiers a
 * producer cannot construct without a cast. The contract's decoder judges this wire shape in tests.
 */
type WireSnapshot = typeof SymmetriaStreamSnapshot.Encoded;
type WireThread = WireSnapshot["threads"][number];
type WireTurn = NonNullable<WireThread["latestTurn"]>;
type WireSession = NonNullable<WireThread["session"]>;

export type ProjectableTurn = {
  readonly turnId: string;
  // The upstream literal union, borrowed rather than widened to `string`: a
  // producer handing this a free-form state would be caught here rather than
  // by the consumer's decoder.
  readonly state: WireTurn["state"];
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

export type ProjectableSession = {
  readonly status: WireSession["status"];
  readonly activeTurnId: string | null;
};

export type ProjectableThread = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurn: ProjectableTurn | null;
  readonly session: ProjectableSession | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly snoozedUntil?: string | null;
  readonly pinnedAt?: string | null;
  readonly deletedAt: string | null;
};

export type ProjectableProject = {
  readonly id: string;
  readonly title: string;
};

export type ProjectableReadModel = {
  readonly projects: ReadonlyArray<ProjectableProject>;
  readonly threads: ReadonlyArray<ProjectableThread>;
};

/**
 * Drops the row on blank text: upstream's non-blank check is lost on emission, and a snapshot that
 * fails to decode takes the whole stream down. ⚠ Takes `unknown`: an IPC push with no `title`
 * once threw here and rejected the invoke. Rows are covered; malformed TOP-LEVEL shapes are not,
 * because `parseFeedPush` rejects them first. A new direct caller must do the same.
 */
const isPublishableText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Nullable free text, refused when present and blank.
 *
 * `branch` and `worktreePath` are nullable on both sides, so a blank one has
 * somewhere to go that dropping the row does not: null says the same true
 * thing and keeps the thread.
 */
const publishableOrNull = (value: string | null): string | null =>
  isPublishableText(value) ? value : null;

/**
 * `title`, `createdAt` and `updatedAt` are required on the wire. Drop the row instead of
 * substituting null: a null makes the consumer's decode reject the whole snapshot over one row.
 */
const isPublishableThread = (thread: ProjectableThread): boolean =>
  isPublishableText(thread.title) &&
  isPublishableText(thread.createdAt) &&
  isPublishableText(thread.updatedAt);

const projectThread = (thread: ProjectableThread): WireThread => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  branch: publishableOrNull(thread.branch ?? null),
  worktreePath: publishableOrNull(thread.worktreePath ?? null),
  // ⚠ Nullish, not `=== null`: across IPC the field can be ABSENT, and a strict check would fall
  // through to the branch that dereferences it.
  latestTurn:
    thread.latestTurn == null
      ? null
      : {
          turnId: thread.latestTurn.turnId,
          state: thread.latestTurn.state,
          requestedAt: thread.latestTurn.requestedAt,
          startedAt: thread.latestTurn.startedAt,
          completedAt: thread.latestTurn.completedAt,
        },
  session:
    thread.session == null
      ? null
      : { status: thread.session.status, activeTurnId: thread.session.activeTurnId ?? null },
  // Token cost is `ThreadTokenUsageSnapshot` and reaches a producer separately
  // from the thread, so there is nothing here to project. Null rather than
  // omitted, because the field is required on the wire and a consumer reading
  // null learns the true thing: this producer does not report cost.
  tokenUsage: null,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt ?? null,
  settledAt: thread.settledAt ?? null,
  // Optional upstream, required on the wire: absent and null mean one thing to
  // a consumer, and making it tell them apart buys nothing.
  snoozedUntil: thread.snoozedUntil ?? null,
  pinnedAt: thread.pinnedAt ?? null,
  deletedAt: thread.deletedAt ?? null,
});

/**
 * The whole projected world at one revision. The CALLER supplies `revision` (`threadFeed.ts`
 * numbers frames): upstream's `snapshotSequence` advances on every event, including the ones this
 * projection drops, so deltas numbered with it would read as gaps.
 */
export function projectReadModel(readModel: ProjectableReadModel, revision: number): WireSnapshot {
  return {
    type: "snapshot",
    protocolVersion: { major: SYMMETRIA_PROTOCOL_MAJOR, minor: SYMMETRIA_PROTOCOL_MINOR },
    revision,
    threads: readModel.threads.filter(isPublishableThread).map(projectThread),
    // Neither is produced by this publisher. Empty rather than absent: the
    // snapshot requires them, and an empty list tells a consumer the truth.
    surfaces: [],
    drafts: [],
    projects: readModel.projects
      .filter((project) => isPublishableText(project.title))
      .map((project) => ({ projectId: project.id, name: project.title })),
  };
}
