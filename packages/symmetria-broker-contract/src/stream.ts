/**
 * Stream semantics only: this package has no publisher, so nothing enforces them at runtime.
 * A delta carries a projected entity, never `OrchestrationEvent` and its free-form payload.
 * A stream opens with a snapshot. A skipped sequence is a `gap` that requires a resnapshot.
 * A reader never buffers or waits out a gap. A replayed delta is a `duplicate`, applied once.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { SymmetriaDraft } from "./draft.ts";
import { SymmetriaProjectSummary } from "./projectSummary.ts";
import { NonNegativeInteger, SymmetriaSnapshotRevision } from "./primitives.ts";
import { SymmetriaSurfacePresence } from "./surfacePresence.ts";
import { SymmetriaThreadSummary } from "./threadSummary.ts";
import {
  SymmetriaProtocolVersion,
  decodeSymmetriaProtocolVersion,
  type SymmetriaProtocolVersionRejection,
} from "./version.ts";

/**
 * One changed entity, tagged `entity` because `type` already discriminates the stream item.
 * Every member with a body also appears in the snapshot, so deltas fold into snapshot state.
 * There is no removal member: a thread leaves through `archivedAt` or `deletedAt`, and a surface
 * leaves when its `expiresAt` passes. Each fact has one mechanism.
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
 * The current composer draft of one thread. The surface that loses a compare-and-set race reads
 * the standing draft here. It carries the draft, never `SymmetriaDraftUpdateResult`, because a
 * conflict answers one caller and every consumer reads the stream.
 */
export const SymmetriaDraftChange = Schema.Struct({
  entity: Schema.Literal("draft"),
  draft: SymmetriaDraft,
});
export type SymmetriaDraftChange = typeof SymmetriaDraftChange.Type;

/**
 * One project's identity, so a consumer that groups threads can print a name.
 * There is no removal member and no tombstone: a consumer stops rendering a project that no
 * thread references, and a second way to leave could disagree with that one.
 */
export const SymmetriaProjectChange = Schema.Struct({
  entity: Schema.Literal("project"),
  project: SymmetriaProjectSummary,
});
export type SymmetriaProjectChange = typeof SymmetriaProjectChange.Type;

/**
 * A change whose entity this build does not know, kept rather than refused: a refusal leaves the
 * position unapplied, turns the next delta into a gap, and forces a resnapshot every time.
 * A known entity with a mismatched body fails the check and stays malformed. The check does not
 * reach the emitted JSON Schema, so only the decoder tells the two apart.
 */
const KNOWN_CHANGE_ENTITIES: ReadonlySet<string> = new Set([
  "thread",
  "surface",
  "draft",
  "project",
]);

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
export const SYMMETRIA_STREAM_CHANGE_ENTITIES = [
  "thread",
  "surface",
  "draft",
  "project",
  "unknown",
] as const;
export type SymmetriaStreamChangeEntity = (typeof SYMMETRIA_STREAM_CHANGE_ENTITIES)[number];

export const SymmetriaStreamChange = Schema.Union([
  SymmetriaThreadChange,
  SymmetriaSurfaceChange,
  SymmetriaDraftChange,
  SymmetriaProjectChange,
  SymmetriaUnknownChange,
]);
export type SymmetriaStreamChange = typeof SymmetriaStreamChange.Type;

/**
 * The whole projected world at one revision. Every stream opens with it.
 * `revision` uses the delta sequence numbering, so the first applicable delta is `revision + 1`.
 * The snapshot negotiates `protocolVersion`, so a delta need not repeat it.
 */
export const SymmetriaStreamSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  protocolVersion: SymmetriaProtocolVersion,
  revision: SymmetriaSnapshotRevision,
  threads: Schema.Array(SymmetriaThreadSummary),
  surfaces: Schema.Array(SymmetriaSurfacePresence),
  drafts: Schema.Array(SymmetriaDraft),
  projects: Schema.Array(SymmetriaProjectSummary),
});
export type SymmetriaStreamSnapshot = typeof SymmetriaStreamSnapshot.Type;

/**
 * One change at one position. `sequence` has no brand, so it compares against a snapshot revision
 * without a cast. The optional `protocolVersion` key makes this schema reject a delta that
 * announces an unsupported major. Without the key, the root schema would drop the announcement.
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
 * Runs the version gate before the schema, so an unsupported major fails as
 * `SymmetriaProtocolVersionMismatch` with both majors, not as a vague schema mismatch.
 * A newer minor never causes a refusal: Effect drops unknown keys at every depth, and an
 * unknown change entity decodes to `SymmetriaUnknownChange`.
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
 * What a consumer holds between items. It is a plain type, not a schema: it never crosses the
 * wire, and a schema would reach the JSON Schema emitter. `sequence` is the last applied position
 * and starts at the snapshot's revision.
 */
export type SymmetriaStreamState = {
  readonly revision: SymmetriaSnapshotRevision;
  readonly sequence: number;
  readonly threads: ReadonlyArray<SymmetriaThreadSummary>;
  readonly surfaces: ReadonlyArray<SymmetriaSurfacePresence>;
  readonly drafts: ReadonlyArray<SymmetriaDraft>;
  readonly projects: ReadonlyArray<SymmetriaProjectSummary>;
};

/** A stream that began with something other than a full snapshot. */
export const SymmetriaStreamNotOpened = Schema.TaggedStruct("SymmetriaStreamNotOpened", {
  receivedType: Schema.Literals(SYMMETRIA_STREAM_ITEM_TYPES),
  receivedSequence: NonNegativeInteger,
});
export type SymmetriaStreamNotOpened = typeof SymmetriaStreamNotOpened.Type;

/**
 * Opens a stream from its first item and refuses a delta, because the consumer would fold
 * changes into a world it never received. The failure carries the sequence that the consumer
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
        projects: item.projects,
      })
    : Result.fail({
        _tag: "SymmetriaStreamNotOpened",
        receivedType: item.type,
        receivedSequence: item.sequence,
      });

/**
 * What one delta did to the state. Every outcome carries `requiresResnapshot`, so a consumer
 * reads one field. A resnapshot is the only recovery for a gap; there is no "wait and see".
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
 * Replaces the matching entry or appends. Every entity kind routes through it (drafts through
 * `upsertNewerDraft`), so an upsert means one thing for all of them. It preserves order, so
 * folding a stream twice produces the same document twice.
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
 * Stores a draft only when it advances that thread's version, because the version is the only
 * draft ordering a consumer may trust. A resync or a lost compare-and-set must not move the draft
 * backwards. The stream still consumes the position when nothing is written.
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
    case "project":
      return {
        ...state,
        projects: upsertBy(
          state.projects,
          change.project,
          (candidate) => candidate.projectId === change.project.projectId,
        ),
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
 * Folds one delta into consumer state. Total: no clock, no buffer, no retry, no failure channel.
 * Any of those would turn this contract into a client. Only the successor of the last applied
 * sequence applies. An earlier position is a `duplicate`. A later one is a `gap`: not applied,
 * not held, and recoverable only by a fresh snapshot.
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
