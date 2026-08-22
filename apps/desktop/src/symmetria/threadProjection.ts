/**
 * Turns the fork's own read model into the snapshot Symmetria Shell reads.
 *
 * Pure: no clock, no IO, no Effect services, the same shape
 * `symmetriaSurfacePresenceFromLease` has inside the contract package. That is
 * what lets the whole projection be judged by the contract's own decoder in a
 * test rather than by a hand-written expectation.
 *
 * ⚠ **Every field is built by name, and Effect's key dropping is the guard
 * rather than the mechanism.** The contract's own note says why: an upstream
 * thread does not decode as a summary unchanged — it calls its identity `id`
 * where the summary calls it `threadId`, and carries no `tokenUsage` at all.
 * A projection written as a spread plus a decode would silently publish
 * whatever upstream adds next until somebody noticed.
 *
 * The input types below are STRUCTURAL rather than imported from
 * `@t3tools/contracts`. Two reasons, and the second is the load-bearing one:
 * the upstream types carry branded strings that a test fixture cannot
 * construct without ceremony, and naming exactly the fields this module reads
 * makes the allowlist visible in the type itself. A field absent from these
 * types cannot be published by accident, because it cannot be reached.
 */
import {
  SYMMETRIA_PROTOCOL_MAJOR,
  SYMMETRIA_PROTOCOL_MINOR,
  SymmetriaStreamSnapshot,
} from "@symmetria/broker-contract";

/**
 * What a producer builds is the ENCODED form, not the decoded one.
 *
 * The contract's exported `SymmetriaStreamSnapshot` type is what a consumer
 * holds AFTER decoding: its identifiers are branded and its revision is a
 * branded number, none of which a producer can construct without casting. What
 * travels is plain JSON, which is exactly `Encoded`. Targeting it means this
 * module builds the wire shape and the contract's decoder judges it — the
 * arrangement the tests already assume, and the reason no cast is needed here.
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
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<ProjectableProject>;
  readonly threads: ReadonlyArray<ProjectableThread>;
};

/**
 * A string the wire will accept where it requires non-blank text.
 *
 * Upstream's types say these cannot be blank, and upstream's check is dropped
 * when its schema becomes JSON Schema — so this producer is the last place
 * that can refuse one. It refuses by DROPPING THE ROW rather than by failing
 * the snapshot: one thread missing from the bar costs the user far less than
 * every thread missing, and a snapshot that fails to decode takes the whole
 * stream down for as long as the bad row survives upstream.
 */
const isPublishableText = (value: string): boolean => value.trim().length > 0;

/**
 * Nullable free text, refused when present and blank.
 *
 * `branch` and `worktreePath` are nullable on both sides, so a blank one has
 * somewhere to go that dropping the row does not: null says the same true
 * thing and keeps the thread.
 */
const publishableOrNull = (value: string | null): string | null =>
  value !== null && isPublishableText(value) ? value : null;

const projectThread = (thread: ProjectableThread): WireThread => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  branch: publishableOrNull(thread.branch),
  worktreePath: publishableOrNull(thread.worktreePath),
  latestTurn:
    thread.latestTurn === null
      ? null
      : {
          turnId: thread.latestTurn.turnId,
          state: thread.latestTurn.state,
          requestedAt: thread.latestTurn.requestedAt,
          startedAt: thread.latestTurn.startedAt,
          completedAt: thread.latestTurn.completedAt,
        },
  session:
    thread.session === null
      ? null
      : { status: thread.session.status, activeTurnId: thread.session.activeTurnId },
  // Token cost is `ThreadTokenUsageSnapshot` and reaches a producer separately
  // from the thread, so there is nothing here to project. Null rather than
  // omitted, because the field is required on the wire and a consumer reading
  // null learns the true thing: this producer does not report cost.
  tokenUsage: null,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  settledAt: thread.settledAt,
  // Optional upstream, required on the wire: absent and null mean one thing to
  // a consumer, and making it tell them apart buys nothing.
  snoozedUntil: thread.snoozedUntil ?? null,
  pinnedAt: thread.pinnedAt ?? null,
  deletedAt: thread.deletedAt,
});

/** The whole projected world at one revision, ready to be written to a peer. */
export function projectReadModel(readModel: ProjectableReadModel): WireSnapshot {
  return {
    type: "snapshot",
    protocolVersion: { major: SYMMETRIA_PROTOCOL_MAJOR, minor: SYMMETRIA_PROTOCOL_MINOR },
    // Borrowed, never counted here. `snapshotSequence` already means "the
    // position in the event sequence this state reflects", which is exactly
    // what a consumer compares its deltas against; a second numbering would
    // make gap detection mean something else on each side.
    revision: readModel.snapshotSequence,
    threads: readModel.threads
      .filter((thread) => isPublishableText(thread.title))
      .map(projectThread),
    // Neither is produced by this publisher. Empty rather than absent: the
    // snapshot requires them, and an empty list tells a consumer the truth.
    surfaces: [],
    drafts: [],
    projects: readModel.projects
      .filter((project) => isPublishableText(project.title))
      .map((project) => ({ projectId: project.id, name: project.title })),
  };
}
