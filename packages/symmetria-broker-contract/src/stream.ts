/**
 * How a surface outside this fork reads the projection over time.
 *
 * **This module defines semantics, and nothing here enforces them at runtime.**
 * The same caveat the command and draft modules carry applies: there is no
 * publisher and no transport in this package, so a green suite proves the
 * contract can *express* an ordered stream, not that any producer emits one.
 *
 * The framing is borrowed rather than invented. `OrchestrationThreadStreamItem`
 * (`packages/contracts/src/orchestration.ts:1492`) is already a tagged union of
 * a snapshot and an event, and `OrchestrationReadModel.snapshotSequence`
 * (`:426`) is already the fork's own snapshot revision — the position in the
 * event sequence that a snapshot reflects. This module keeps both meanings and
 * changes only what travels: a delta carries a projected entity, never
 * `OrchestrationEvent` itself, whose `metadata` and per-type `payload` are the
 * free-form provider content the projection is an allowlist against.
 *
 * Three rules hold the whole framing together, and each one exists because the
 * alternative makes a consumer guess:
 *
 * - **A stream opens with a snapshot.** `openSymmetriaStream` is the only way to
 *   get a state, and it refuses a delta. A consumer that started mid-stream
 *   would render a partial world and never learn what it was missing.
 * - **A gap is reported, never repaired.** A sequence that skips ahead yields a
 *   `gap` that requires a resnapshot. This module does not buffer, does not
 *   reorder and holds no clock, because a gap that resolves itself by waiting is
 *   the consumer inferring a missing event from a local timeout — which the
 *   contract forbids outright.
 * - **A duplicate is normal traffic.** A delta replayed after a reconnect is
 *   reported as `duplicate` and applied once. It is a distinct outcome from an
 *   error, and it is the stream-level companion of the receipt idempotency in
 *   `command.ts`.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { SymmetriaDraft } from "./draft.ts";
import { NonNegativeInteger, SymmetriaSnapshotRevision } from "./primitives.ts";
import { SymmetriaSurfacePresence } from "./surfacePresence.ts";
import { SymmetriaThreadSummary } from "./threadSummary.ts";
import {
  SymmetriaProtocolVersion,
  decodeSymmetriaProtocolVersion,
  type SymmetriaProtocolVersionRejection,
} from "./version.ts";

/**
 * One changed entity, tagged by which of the projections it is.
 *
 * The tag is `entity` and not `type`, because `type` already discriminates the
 * stream item itself and one payload carrying two `type` keys at two depths is
 * how a consumer branches on the wrong one.
 *
 * Every member that carries a body also appears in the snapshot, which is what
 * lets a consumer fold deltas into the state a snapshot opened without ever
 * holding a shape the snapshot cannot describe. `SymmetriaUnknownChange` below
 * is the one member with no body, and it writes nothing for exactly that reason.
 *
 * There is no removal member, and that is the design rather than an omission.
 * A thread that goes away says so in its own summary — `archivedAt` and
 * `deletedAt` are fields of `SymmetriaThreadSummary` — and a presence row is
 * valid only until its `expiresAt`, so a producer retires a surface early by
 * publishing a shortened expiry. One mechanism per fact, and no second way for
 * an entity to leave that a consumer could miss.
 */
export const SymmetriaThreadChange = Schema.Struct({
  entity: Schema.Literal("thread"),
  thread: SymmetriaThreadSummary,
});
export type SymmetriaThreadChange = typeof SymmetriaThreadChange.Type;

export const SymmetriaSurfaceChange = Schema.Struct({
  entity: Schema.Literal("surface"),
  surface: SymmetriaSurfacePresence,
});
export type SymmetriaSurfaceChange = typeof SymmetriaSurfaceChange.Type;

/**
 * The current composer draft of one thread.
 *
 * This is the delta `draft.ts` points at: the surface that loses a
 * compare-and-set race learns the draft that stands from the stream it already
 * holds, rather than from a second request. It carries the draft body and never
 * `SymmetriaDraftUpdateResult`, because a conflict is one caller's answer and a
 * stream is read by every consumer.
 */
export const SymmetriaDraftChange = Schema.Struct({
  entity: Schema.Literal("draft"),
  draft: SymmetriaDraft,
});
export type SymmetriaDraftChange = typeof SymmetriaDraftChange.Type;

/**
 * A change this build cannot read, kept rather than refused.
 *
 * A minor bump is additive by definition, so a 1.1 producer may name an entity
 * this build has never heard of. Refusing the delta outright would cost the
 * consumer far more than the update it could not read: the position would never
 * be applied, the next in-order delta would look like a gap, and every
 * occurrence would force a full resnapshot. So an unrecognized entity degrades
 * the way an unrecognized surface kind does in `surfacePresence.ts:71` — the
 * item survives, and the consumer skips one update it was never going to
 * understand.
 *
 * The check on the source string is what keeps this from swallowing corruption.
 * A payload naming a *known* entity with a body that does not match it fails the
 * check, so it never reaches this member and is still reported as malformed. The
 * name itself is not carried: `entity` decodes to `unknown`, so a consumer
 * branching on the tag has four cases and not an open string, and re-encoding
 * such a change writes `unknown` rather than the name it arrived under.
 *
 * Measured limit, the same class as the conflict filter in `draft.ts:110`: a
 * check that is not a pattern does not survive into the emitted JSON Schema, so
 * a consumer that is not TypeScript sees a bare string here and would accept a
 * mismatched known entity as an unknown one. The decoder is the only reader that
 * can tell those apart, and it errs toward accepting rather than dropping, which
 * is the same direction `additionalProperties: true` errs in.
 */
const KNOWN_CHANGE_ENTITIES: ReadonlySet<string> = new Set(["thread", "surface", "draft"]);

const UnrecognizedChangeEntity = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      !KNOWN_CHANGE_ENTITIES.has(value) ||
      `A change naming the known entity ${value} did not match that entity's shape.`,
  ),
);

export const SymmetriaUnknownChange = Schema.Struct({
  entity: UnrecognizedChangeEntity.pipe(
    Schema.decodeTo(
      Schema.Literal("unknown"),
      SchemaTransformation.transform<"unknown", string>({
        decode: () => "unknown",
        encode: () => "unknown",
      }),
    ),
  ),
});
export type SymmetriaUnknownChange = typeof SymmetriaUnknownChange.Type;

/** Every entity a delta can carry, as a value so a consumer branches on a list. */
export const SYMMETRIA_STREAM_CHANGE_ENTITIES = ["thread", "surface", "draft", "unknown"] as const;
export type SymmetriaStreamChangeEntity = (typeof SYMMETRIA_STREAM_CHANGE_ENTITIES)[number];

export const SymmetriaStreamChange = Schema.Union([
  SymmetriaThreadChange,
  SymmetriaSurfaceChange,
  SymmetriaDraftChange,
  SymmetriaUnknownChange,
]);
export type SymmetriaStreamChange = typeof SymmetriaStreamChange.Type;

/**
 * The whole projected world at one revision, and the item every stream opens
 * with.
 *
 * `revision` is a position in the same sequence the deltas number, which is what
 * `OrchestrationReadModel.snapshotSequence` already means upstream. So the first
 * delta a consumer may apply is `revision + 1`, and the arithmetic that makes a
 * gap detectable needs no second field.
 *
 * `protocolVersion` is announced here and not repeated on every delta. The
 * snapshot is where a stream is negotiated, a delta is the hot path, and a
 * consumer that accepted the opening snapshot has already settled which major it
 * is speaking for the life of that stream. `decodeSymmetriaStreamItem` gates any
 * item that announces a version, so a producer that chooses to repeat it on a
 * delta is still checked.
 */
export const SymmetriaStreamSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  protocolVersion: SymmetriaProtocolVersion,
  revision: SymmetriaSnapshotRevision,
  threads: Schema.Array(SymmetriaThreadSummary),
  surfaces: Schema.Array(SymmetriaSurfacePresence),
  drafts: Schema.Array(SymmetriaDraft),
});
export type SymmetriaStreamSnapshot = typeof SymmetriaStreamSnapshot.Type;

/**
 * One change at one position. `sequence` is `NonNegativeInteger` rather than a
 * brand of its own, the same as the accepted position on
 * `SymmetriaCommandAppliedReceipt`: a consumer compares it against a snapshot
 * revision, and two brands over one number line would make that comparison need
 * a cast.
 *
 * `protocolVersion` is an optional key, which is the whole of the difference
 * from the snapshot. A delta need not repeat what the opening snapshot already
 * settled, and a producer that does repeat it is checked by this schema rather
 * than only by `decodeSymmetriaStreamItem`. Without the key the schema itself
 * would accept a delta announcing a major this build does not speak and drop the
 * announcement silently, so a consumer reaching for the exported root schema
 * instead of the gate would fold foreign-major data into its state.
 */
export const SymmetriaStreamDelta = Schema.Struct({
  type: Schema.Literal("delta"),
  protocolVersion: Schema.optionalKey(SymmetriaProtocolVersion),
  sequence: NonNegativeInteger,
  change: SymmetriaStreamChange,
});
export type SymmetriaStreamDelta = typeof SymmetriaStreamDelta.Type;

/** Every stream item type, as a value so a consumer branches on a list. */
export const SYMMETRIA_STREAM_ITEM_TYPES = ["snapshot", "delta"] as const;
export type SymmetriaStreamItemType = (typeof SYMMETRIA_STREAM_ITEM_TYPES)[number];

/** What a consumer reads off the stream, in either of its two shapes. */
export const SymmetriaStreamItem = Schema.Union([SymmetriaStreamSnapshot, SymmetriaStreamDelta]);
export type SymmetriaStreamItem = typeof SymmetriaStreamItem.Type;

/** The payload was not a stream item this build can read at all. */
export const SymmetriaStreamItemMalformed = Schema.TaggedStruct("SymmetriaStreamItemMalformed", {
  issue: Schema.String,
});
export type SymmetriaStreamItemMalformed = typeof SymmetriaStreamItemMalformed.Type;

/**
 * Every typed reason a stream item is refused. The version rejections come from
 * `version.ts` unchanged, so a consumer that already branches on the gate's
 * failures branches on these with no second table.
 */
export type SymmetriaStreamItemRejection =
  | SymmetriaProtocolVersionRejection
  | SymmetriaStreamItemMalformed;

const decodeItem = Schema.decodeUnknownResult(SymmetriaStreamItem);

/** The announced version of a payload, before anything has been decoded. */
const announcedProtocolVersionOf = (input: unknown): unknown =>
  typeof input === "object" && input !== null && "protocolVersion" in input
    ? (input as { readonly protocolVersion: unknown }).protocolVersion
    : undefined;

/**
 * Reads one payload off the wire, running the version gate before the schema.
 *
 * The order is the point. An unsupported major is refused with
 * `SymmetriaProtocolVersionMismatch`, which names both the major this build
 * speaks and the major the producer announced — a consumer that cannot say what
 * it expected cannot report a useful error, and a schema failure over an unknown
 * literal would say only that something did not match.
 *
 * Nothing a newer *minor* can add is a refusal. An unknown field is dropped —
 * Effect drops a key this contract does not name, at every depth, so a payload
 * from a newer minor decodes to exactly the fields this build knows, which is
 * why the emitted JSON Schema sets `additionalProperties` to true. An unknown
 * change entity degrades to `SymmetriaUnknownChange` rather than failing, for
 * the same reason and at a higher cost if it did not: see that member. Only a
 * major refuses.
 */
export const decodeSymmetriaStreamItem = (
  input: unknown,
): Result.Result<SymmetriaStreamItem, SymmetriaStreamItemRejection> => {
  const announced = announcedProtocolVersionOf(input);
  if (announced !== undefined) {
    const gate = decodeSymmetriaProtocolVersion(announced);
    if (Result.isFailure(gate)) {
      return Result.fail(gate.failure);
    }
  }
  const decoded = decodeItem(input);
  return Result.isFailure(decoded)
    ? Result.fail({ _tag: "SymmetriaStreamItemMalformed", issue: decoded.failure.message })
    : Result.succeed(decoded.success);
};

/**
 * What a consumer holds between items.
 *
 * A plain type and not a schema, deliberately. This never crosses the wire — it
 * is what a reader accumulates locally — and declaring it as a schema would
 * offer it to the JSON Schema emitter as though a producer could send one.
 *
 * `sequence` is the last position applied. It starts at the snapshot's revision,
 * because a snapshot already reflects every delta up to that position.
 */
export type SymmetriaStreamState = {
  readonly revision: SymmetriaSnapshotRevision;
  readonly sequence: number;
  readonly threads: ReadonlyArray<SymmetriaThreadSummary>;
  readonly surfaces: ReadonlyArray<SymmetriaSurfacePresence>;
  readonly drafts: ReadonlyArray<SymmetriaDraft>;
};

/** A stream that began with something other than a full snapshot. */
export const SymmetriaStreamNotOpened = Schema.TaggedStruct("SymmetriaStreamNotOpened", {
  receivedType: Schema.Literals(SYMMETRIA_STREAM_ITEM_TYPES),
  receivedSequence: NonNegativeInteger,
});
export type SymmetriaStreamNotOpened = typeof SymmetriaStreamNotOpened.Type;

/**
 * Opens a stream from its first item.
 *
 * A delta first is refused rather than tolerated: the consumer would be folding
 * changes into a world it never received, and nothing later in the stream would
 * tell it so. The failure carries the sequence it saw, which is what a consumer
 * asks the producer to snapshot from.
 */
export const openSymmetriaStream = (
  item: SymmetriaStreamItem,
): Result.Result<SymmetriaStreamState, SymmetriaStreamNotOpened> =>
  item.type === "snapshot"
    ? Result.succeed({
        revision: item.revision,
        sequence: item.revision,
        threads: item.threads,
        surfaces: item.surfaces,
        drafts: item.drafts,
      })
    : Result.fail({
        _tag: "SymmetriaStreamNotOpened",
        receivedType: item.type,
        receivedSequence: item.sequence,
      });

/**
 * What one delta did to the state.
 *
 * `requiresResnapshot` is present on every outcome rather than only on a gap, so
 * a consumer reads one field to decide whether it has to reopen and never has to
 * tell an absent key from a false one. It is the only recovery this contract
 * offers for a gap; there is deliberately no "wait and see".
 */
export type SymmetriaStreamDeltaApplied = {
  readonly outcome: "applied";
  readonly requiresResnapshot: false;
  readonly state: SymmetriaStreamState;
};

export type SymmetriaStreamDeltaDuplicate = {
  readonly outcome: "duplicate";
  readonly requiresResnapshot: false;
  readonly state: SymmetriaStreamState;
};

export type SymmetriaStreamDeltaGap = {
  readonly outcome: "gap";
  readonly requiresResnapshot: true;
  readonly state: SymmetriaStreamState;
  readonly expectedSequence: number;
  readonly receivedSequence: number;
};

export type SymmetriaStreamDeltaResult =
  | SymmetriaStreamDeltaApplied
  | SymmetriaStreamDeltaDuplicate
  | SymmetriaStreamDeltaGap;

/**
 * Replaces the entry that matches, or appends when nothing does. Shared by all
 * three entity kinds so an upsert cannot mean one thing for a thread and another
 * for a surface, and order-preserving so folding a stream twice produces the
 * same document twice.
 */
const upsertBy = <A>(
  items: ReadonlyArray<A>,
  next: A,
  matches: (candidate: A) => boolean,
): ReadonlyArray<A> => {
  const index = items.findIndex(matches);
  return index === -1 ? [...items, next] : items.map((item, at) => (at === index ? next : item));
};

/**
 * Stores a draft only when it advances that thread's version.
 *
 * Position and version are two different orderings and only one of them is the
 * draft's own. `draft.ts:53` says it in as many words — the version is the only
 * ordering a consumer may trust — so a producer that re-emits a draft row on a
 * resync, or publishes the body a lost compare-and-set was about to overwrite,
 * must not walk the consumer's draft backwards. A delta that does not advance
 * the version is still applied at the stream level: the position is consumed and
 * nothing is written.
 */
const upsertNewerDraft = (
  drafts: ReadonlyArray<SymmetriaDraft>,
  next: SymmetriaDraft,
): ReadonlyArray<SymmetriaDraft> => {
  const held = drafts.find((candidate) => candidate.threadId === next.threadId);
  if (held !== undefined && next.version <= held.version) {
    return drafts;
  }
  return upsertBy(drafts, next, (candidate) => candidate.threadId === next.threadId);
};

const withChange = (
  state: SymmetriaStreamState,
  change: SymmetriaStreamChange,
): SymmetriaStreamState => {
  switch (change.entity) {
    case "thread":
      return {
        ...state,
        threads: upsertBy(
          state.threads,
          change.thread,
          (candidate) => candidate.threadId === change.thread.threadId,
        ),
      };
    case "surface":
      return {
        ...state,
        surfaces: upsertBy(
          state.surfaces,
          change.surface,
          (candidate) => candidate.clientId === change.surface.clientId,
        ),
      };
    case "draft":
      return {
        ...state,
        drafts: upsertNewerDraft(state.drafts, change.draft),
      };
    case "unknown":
      // A change this build cannot read leaves every list as it was. The
      // position is still consumed by the caller, which is the point: one
      // skipped update costs less than the resnapshot that refusing it would
      // force on every occurrence.
      return state;
  }
};

/**
 * Folds one delta into consumer state, and reports what it did.
 *
 * Total: it holds no clock, no buffer and no failure channel, and it answers
 * every pair of inputs with one member of the result union. Keeping it that way
 * is what stops it becoming the consumer this run excludes — the moment it grows
 * a clock, a pending buffer or a retry it is a client and not a contract.
 *
 * Exactly one position advances the state: the successor of the last applied
 * sequence. A position already seen is a `duplicate` — normal traffic after a
 * reconnect, applied once and never twice. A position beyond the successor is a
 * `gap`: the delta is not applied, not held, and not inferred about, because the
 * consumer cannot know what the missing positions carried. Its only recovery is
 * a fresh snapshot.
 */
export const applySymmetriaStreamDelta = (
  state: SymmetriaStreamState,
  delta: SymmetriaStreamDelta,
): SymmetriaStreamDeltaResult => {
  const expectedSequence = state.sequence + 1;
  if (delta.sequence <= state.sequence) {
    return { outcome: "duplicate", requiresResnapshot: false, state };
  }
  if (delta.sequence > expectedSequence) {
    return {
      outcome: "gap",
      requiresResnapshot: true,
      state,
      expectedSequence,
      receivedSequence: delta.sequence,
    };
  }
  return {
    outcome: "applied",
    requiresResnapshot: false,
    state: { ...withChange(state, delta.change), sequence: delta.sequence },
  };
};
