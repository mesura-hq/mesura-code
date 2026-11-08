// @effect-diagnostics nodeBuiltinImport:off - batch identity is a SHA-256 digest.
/**
 * ProjectionVoiceCallRepository - Mesura: projection of persisted voice call history.
 *
 * Rows are derived from the thread.voice-* events and are rebuilt by replaying the event store.
 *
 * @module ProjectionVoiceCallRepository
 */
import * as NodeCrypto from "node:crypto";

import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  VoiceCallEndReason,
  VoiceCallId,
  VoiceHistoryItemId,
  VoiceTranscriptFragment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionVoiceCall = Schema.Struct({
  callId: VoiceCallId,
  threadId: ThreadId,
  ownerKey: Schema.String,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  endReason: Schema.NullOr(VoiceCallEndReason),
  finalSequence: Schema.NullOr(NonNegativeInt),
  lastSequence: NonNegativeInt,
});
export type ProjectionVoiceCall = typeof ProjectionVoiceCall.Type;

export interface ProjectionVoiceFragment extends VoiceTranscriptFragment {
  /** The batch that first stored this fragment. */
  readonly batchId: string;
}

export const InsertProjectionVoiceCallInput = Schema.Struct({
  callId: VoiceCallId,
  threadId: ThreadId,
  ownerKey: Schema.String,
  startedAt: IsoDateTime,
});
export type InsertProjectionVoiceCallInput = typeof InsertProjectionVoiceCallInput.Type;

export interface AppendProjectionVoiceFragmentsInput {
  readonly callId: string;
  readonly batchId: string;
  readonly fragments: ReadonlyArray<VoiceTranscriptFragment>;
}

export const EndProjectionVoiceCallInput = Schema.Struct({
  callId: VoiceCallId,
  reason: VoiceCallEndReason,
  endedAt: IsoDateTime,
  finalSequence: Schema.NullOr(NonNegativeInt),
});
export type EndProjectionVoiceCallInput = typeof EndProjectionVoiceCallInput.Type;

/** Keyset position of the last call on the previous page, newest first. */
export interface ProjectionVoiceCallCursor {
  readonly startedAt: string;
  readonly callId: string;
}

export interface ListProjectionVoiceCallsInput {
  readonly threadId: ThreadId;
  readonly limit: number;
  readonly before: ProjectionVoiceCallCursor | null;
}

export interface ListProjectionVoiceFragmentsInput {
  readonly callId: string;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface FindProjectionVoiceFragmentsInput {
  readonly callId: string;
  readonly sequences: ReadonlyArray<number>;
  readonly fragmentIds: ReadonlyArray<string>;
}

export const GetProjectionVoiceBatchInput = Schema.Struct({
  callId: VoiceCallId,
  batchId: VoiceHistoryItemId,
});
export type GetProjectionVoiceBatchInput = typeof GetProjectionVoiceBatchInput.Type;

/**
 * The identity of a complete batch request: every fragment, in order, with its exact text and
 * offsets. Two requests under one batch ID are the same only when this digest is equal.
 */
export const voiceBatchContentDigest = (fragments: ReadonlyArray<VoiceTranscriptFragment>) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        fragments.map((fragment) => [
          fragment.fragmentId,
          fragment.sequence,
          fragment.speaker,
          fragment.text,
          fragment.startOffsetMs ?? null,
          fragment.endOffsetMs ?? null,
        ]),
      ),
    )
    .digest("hex");

export interface ProjectionVoiceCallRepositoryShape {
  /** Record a started call. Replaying the same start keeps the first row. */
  readonly insertCall: (
    input: InsertProjectionVoiceCallInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Record an accepted batch: its content digest, the fragments not stored yet, and the call's
   * highest stored sequence. A fragment already stored keeps its first content.
   */
  readonly appendFragments: (
    input: AppendProjectionVoiceFragmentsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Record an end. The first end keeps its reason and time; a later end only fills a missing
   * final boundary.
   */
  readonly markEnded: (
    input: EndProjectionVoiceCallInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getCall: (input: {
    readonly callId: string;
  }) => Effect.Effect<Option.Option<ProjectionVoiceCall>, ProjectionRepositoryError>;
  readonly listCalls: (
    input: ListProjectionVoiceCallsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionVoiceCall>, ProjectionRepositoryError>;
  readonly listOpenCalls: () => Effect.Effect<
    ReadonlyArray<ProjectionVoiceCall>,
    ProjectionRepositoryError
  >;
  readonly listFragments: (
    input: ListProjectionVoiceFragmentsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionVoiceFragment>, ProjectionRepositoryError>;
  /** Stored fragments that share a sequence or a fragment ID with the input. */
  readonly findFragments: (
    input: FindProjectionVoiceFragmentsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionVoiceFragment>, ProjectionRepositoryError>;
  /** The content digest a batch ID was first accepted with. */
  readonly getBatchDigest: (
    input: GetProjectionVoiceBatchInput,
  ) => Effect.Effect<Option.Option<string>, ProjectionRepositoryError>;
}

export class ProjectionVoiceCallRepository extends Context.Service<
  ProjectionVoiceCallRepository,
  ProjectionVoiceCallRepositoryShape
>()("t3/persistence/Services/ProjectionVoiceCalls/ProjectionVoiceCallRepository") {}
