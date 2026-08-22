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
 *
 * ⚠ It takes `unknown` rather than `string`, and that is the repair of a real
 * crash rather than defensive habit. The value reaches here from an IPC
 * payload, so the TYPE is a claim about what the sender should have sent, not
 * about what arrived. Review reproduced it: a push whose project carried no
 * `title` reached `value.trim()` and threw inside the `Effect.sync` of the IPC
 * handler — becoming a defect that rejects the invoke, which is precisely what
 * that handler's own comment says must never happen.
 *
 * ⚠ **Be exact about what this buys, because the first version of this note
 * was not.** `projectReadModel` is total against a malformed ROW — a missing
 * field, a wrong type, a nested null. It is NOT total against a malformed
 * TOP-LEVEL shape: `threads` that is not an array, a null entry inside one, an
 * empty `readModel`. Verification measured that distinction after the repair
 * claimed more than it delivered.
 *
 * That is a deliberate two-layer arrangement rather than a remaining hole:
 * `parseFeedPush` rejects every one of those shapes before this function is
 * reached, and it is the only caller on the IPC path. A future caller reaching
 * this directly is the case to be careful about.
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
 * Whether a row carries everything the wire requires of it.
 *
 * `title`, `createdAt` and `updatedAt` are required strings on the wire, so a
 * row missing any of them cannot be published — and substituting null would be
 * WORSE than dropping it, because the consumer's decode would then reject the
 * whole snapshot over one bad row. That was the first repair attempted here
 * and it traded a crash for an invalid payload; the same reasoning as the
 * blank title, applied to the fields with no nullable form to fall back on.
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
  // ⚠ Nullish rather than `=== null`, and the two are not interchangeable
  // here. The value arrives across an IPC boundary where a field can be
  // ABSENT, and `undefined === null` is false — so a strict check falls
  // through to the branch that dereferences it. Review found the same shape in
  // `isPublishableText`; this is its sibling, caught by the test written for
  // that one.
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
 * The whole projected world at one revision, ready to be written to a peer.
 *
 * ⚠ `revision` is supplied by the CALLER and is not read from the read model,
 * which reverses this function's first version. It used to take upstream's
 * `snapshotSequence`, on the contract's own reasoning that the field already
 * means "the position a snapshot reflects". Measured afterwards:
 * `projector.ts:203` sets that field from `event.sequence`, so it advances on
 * every orchestration event including the transcript ones this projection
 * drops — numbering deltas with it would make a consumer read a gap on nearly
 * every update. `threadFeed.ts` owns the numbering instead, and its module
 * note carries the full argument.
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
