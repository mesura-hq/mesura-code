import type {
  VoiceCallSummary,
  VoiceTranscriptAppendInput,
  VoiceTranscriptFragment,
  VoiceTranscriptSpeaker,
} from "@t3tools/contracts";
import type { LiveVoiceEvent } from "./protocol.ts";

export const VOICE_HISTORY_FLUSH_INTERVAL_MS = 500;
export const VOICE_HISTORY_FLUSH_BYTES = 16 * 1024;
export const VOICE_HISTORY_MAX_BATCH_FRAGMENTS = 32;
export const VOICE_HISTORY_MAX_PENDING_BYTES = 256 * 1024;
/** The contract's maximum fragment length, in UTF-16 code units. */
const MAX_FRAGMENT_LENGTH = 12_000;

/**
 * Who may send pending text: one environment and the verified owner it reported. Pending text
 * is never sent under another owner or to another environment. It holds no credential.
 */
export interface VoiceHistoryOwner {
  readonly environmentId: string;
  readonly clientIdentity: string;
}

/** A batch keeps its IDs and sequences from before its first attempt until the server confirms it. */
export interface VoiceHistoryPendingBatch {
  readonly owner: VoiceHistoryOwner;
  readonly threadId: string;
  readonly callId: string;
  readonly batchId: string;
  readonly fragments: ReadonlyArray<VoiceTranscriptFragment>;
}

/** The host's durable storage for unconfirmed batches. A batch is removed only after an ACK. */
export interface VoiceHistoryPendingStore {
  readonly list: () => Promise<ReadonlyArray<VoiceHistoryPendingBatch>>;
  readonly put: (batch: VoiceHistoryPendingBatch) => Promise<void>;
  readonly remove: (batch: VoiceHistoryPendingBatch) => Promise<void>;
}

/** The environment's history routes, bound by the host to one environment and credential. */
export interface VoiceHistoryClient {
  readonly append: (
    input: VoiceTranscriptAppendInput,
  ) => Promise<{ readonly lastSequence: number }>;
  /** The call's summary for the requester, or null when the environment does not know it. */
  readonly readCall: (input: {
    readonly threadId: string;
    readonly callId: string;
  }) => Promise<VoiceCallSummary | null>;
  readonly end: (input: {
    readonly callId: string;
    readonly lastSequence: number;
  }) => Promise<void>;
}

/**
 * `idle`: nothing recorded. `saving`: text is waiting for the server. `saved`: the server
 * confirmed every recorded fragment. `pending`: a send failed and the text waits for a retry.
 * `failed`: storage failed or the call reached its pending limit; nothing more is recorded.
 */
export type VoiceHistorySyncState = "idle" | "saving" | "saved" | "pending" | "failed";

export interface VoiceHistoryRecorderOptions {
  readonly owner: VoiceHistoryOwner;
  readonly threadId: string;
  readonly callId: string;
  readonly store: VoiceHistoryPendingStore;
  readonly client: Pick<VoiceHistoryClient, "append">;
  readonly makeId: () => string;
  /** Recording stopped. The host ends the call and shows the message. */
  readonly onFailure: (message: string) => void;
  readonly onStateChange?: (state: VoiceHistorySyncState) => void;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** The longest prefix of `text` within `length` code units that does not split a surrogate pair. */
const fittingPrefixLength = (text: string, length: number) =>
  length > 0 && length < text.length && isHighSurrogate(text.charCodeAt(length - 1))
    ? length - 1
    : Math.min(length, text.length);

const offset = (value: number | undefined) =>
  value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;

export const sameVoiceHistoryOwner = (left: VoiceHistoryOwner, right: VoiceHistoryOwner) =>
  left.environmentId === right.environmentId && left.clientIdentity === right.clientIdentity;

const STORAGE_FAILURE_MESSAGE =
  "This browser could not save the voice history, so the call ended. Text saved before the failure is kept and will be sent when this environment reconnects.";
const LIMIT_MESSAGE =
  "The voice history waiting to be sent reached its 256 KiB limit, so the call ended. The saved text is kept and will be sent when this environment reconnects.";

interface OpenFragment {
  speaker: VoiceTranscriptSpeaker;
  text: string;
  bytes: number;
  startOffsetMs: number | undefined;
  endOffsetMs: number | undefined;
}

interface QueuedBatch {
  readonly batch: VoiceHistoryPendingBatch;
  readonly bytes: number;
  /** Resolves false when storage rejected the batch. */
  readonly stored: Promise<boolean>;
}

/**
 * Records one call's spoken transcript as ordered fragments, from the same events as the visual
 * captions but without their window. Text is stored before its first send, sent in order, and
 * removed only after the server confirms it. Recording never waits for storage or the network.
 */
export function createVoiceHistoryRecorder(options: VoiceHistoryRecorderOptions) {
  const schedule = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancel = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  let nextSequence = 1;
  let open: OpenFragment | null = null;
  const sealed: Array<{ fragment: VoiceTranscriptFragment; bytes: number }> = [];
  const queue: QueuedBatch[] = [];
  /** Every recorded byte the server has not confirmed: open, sealed, stored and in flight. */
  let pendingBytes = 0;
  let unbatchedBytes = 0;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let finished = false;
  let failed = false;
  let storeChain: Promise<unknown> = Promise.resolve();
  let pumping: Promise<void> | null = null;
  let state: VoiceHistorySyncState = "idle";

  const setState = (next: VoiceHistorySyncState) => {
    if (state === next || state === "failed") return;
    state = next;
    options.onStateChange?.(state);
  };

  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    if (timer !== null) cancel(timer);
    timer = null;
    open = null;
    sealed.length = 0;
    setState("failed");
    options.onFailure(message);
  };

  const sealOpen = () => {
    if (!open || !open.text) return;
    sealed.push({
      fragment: {
        fragmentId: options.makeId(),
        sequence: nextSequence++,
        speaker: open.speaker,
        text: open.text,
        ...(open.startOffsetMs === undefined ? {} : { startOffsetMs: open.startOffsetMs }),
        ...(open.endOffsetMs === undefined || open.endOffsetMs < (open.startOffsetMs ?? 0)
          ? {}
          : { endOffsetMs: open.endOffsetMs }),
      },
      bytes: open.bytes,
    });
    open = null;
  };

  /** Seals the current text and queues new batches. Each batch is stored before it is sent. */
  const cut = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    if (failed) return;
    sealOpen();
    unbatchedBytes = 0;
    while (sealed.length > 0) {
      const items = sealed.splice(0, VOICE_HISTORY_MAX_BATCH_FRAGMENTS);
      const batch: VoiceHistoryPendingBatch = {
        owner: options.owner,
        threadId: options.threadId,
        callId: options.callId,
        batchId: options.makeId(),
        fragments: items.map((item) => item.fragment),
      };
      // Puts run in order, so storage never holds a later batch without the earlier one.
      const stored = storeChain.then(() =>
        options.store.put(batch).then(
          () => true,
          () => {
            fail(STORAGE_FAILURE_MESSAGE);
            return false;
          },
        ),
      );
      storeChain = stored;
      queue.push({ batch, bytes: items.reduce((total, item) => total + item.bytes, 0), stored });
    }
    if (queue.length > 0) {
      setState("saving");
      void startPump();
    }
  };

  /** Sends stored batches strictly in order. A failed batch stops later ones from overtaking it. */
  const pump = async () => {
    while (queue.length > 0) {
      const head = queue[0]!;
      if (!(await head.stored)) return;
      try {
        await options.client.append({
          sessionId: head.batch.callId,
          batchId: head.batch.batchId,
          fragments: head.batch.fragments,
        });
      } catch {
        setState("pending");
        return;
      }
      queue.shift();
      pendingBytes -= head.bytes;
      // A batch whose removal fails is resent later; the server treats the exact retry as a no-op.
      await options.store.remove(head.batch).catch(() => undefined);
    }
    if (!open && sealed.length === 0) setState(nextSequence > 1 ? "saved" : "idle");
  };

  const startPump = (): Promise<void> => {
    if (pumping) return pumping;
    pumping = pump().finally(() => {
      pumping = null;
    });
    return pumping;
  };

  const appendText = (
    speaker: VoiceTranscriptSpeaker,
    text: string,
    start: number | undefined,
    end: number | undefined,
  ) => {
    let remaining = text;
    while (remaining) {
      if (open && open.speaker !== speaker) sealOpen();
      open ??= { speaker, text: "", bytes: 0, startOffsetMs: start, endOffsetMs: undefined };
      const room = fittingPrefixLength(remaining, MAX_FRAGMENT_LENGTH - open.text.length);
      if (room === 0) {
        sealOpen();
        continue;
      }
      const part = remaining.slice(0, room);
      remaining = remaining.slice(room);
      open.text += part;
      open.bytes += utf8Bytes(part);
      if (end !== undefined) open.endOffsetMs = end;
      if (remaining) sealOpen();
    }
  };

  return {
    /** Records one transport event. It never waits and never throws. */
    event(event: LiveVoiceEvent) {
      if (finished || failed) return;
      if (
        event.type !== "session.input_transcript.delta" &&
        event.type !== "session.output_transcript.delta"
      )
        return;
      if (!event.delta) return;
      const bytes = utf8Bytes(event.delta);
      if (pendingBytes + bytes > VOICE_HISTORY_MAX_PENDING_BYTES) {
        fail(LIMIT_MESSAGE);
        return;
      }
      pendingBytes += bytes;
      unbatchedBytes += bytes;
      appendText(
        event.type === "session.input_transcript.delta" ? "user" : "assistant",
        event.delta,
        offset(event.start_ms),
        offset(event.end_ms),
      );
      setState("saving");
      if (unbatchedBytes >= VOICE_HISTORY_FLUSH_BYTES) cut();
      else if (timer === null) timer = schedule(cut, VOICE_HISTORY_FLUSH_INTERVAL_MS);
    },
    /** Queues the current text and sends every stored batch once more. It never rejects. */
    async flush() {
      cut();
      // A running pump already sends what cut() queued; otherwise retry what is still stored.
      if (pumping) await pumping;
      else if (queue.length > 0) await startPump();
    },
    /**
     * Stops recording and stores the last text. Returns the call's final sequence, the boundary
     * the host declares when it ends the call.
     */
    async finish(): Promise<number> {
      cut();
      finished = true;
      await storeChain;
      return nextSequence - 1;
    },
    get lastSequence() {
      return nextSequence - 1;
    },
    get state(): VoiceHistorySyncState {
      return state;
    },
  };
}

export type VoiceHistoryRecorder = ReturnType<typeof createVoiceHistoryRecorder>;

export interface VoiceHistoryResumeResult {
  readonly sent: number;
  readonly retained: number;
  /** One explanation per call whose pending text could not be sent now. */
  readonly errors: ReadonlyArray<string>;
}

const errorText = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The environment did not respond.";

const lastFragmentSequence = (batch: VoiceHistoryPendingBatch) =>
  Math.max(...batch.fragments.map((fragment) => fragment.sequence));

/**
 * Sends the pending batches this owner left behind, call by call and in sequence order. A call
 * the environment does not confirm as the requester's own gets no request at all. A call the
 * server ended without a boundary first gets one, from the stored text only; an accepted
 * boundary is never moved. Batches stay stored until the server confirms them.
 */
export async function resumeVoiceHistoryOutbox(input: {
  readonly owner: VoiceHistoryOwner;
  readonly store: VoiceHistoryPendingStore;
  readonly client: VoiceHistoryClient;
  /** Calls a live recorder still owns, such as the call in progress. */
  readonly excludeCallIds?: ReadonlySet<string>;
}): Promise<VoiceHistoryResumeResult> {
  const pending = (await input.store.list()).filter(
    (batch) =>
      sameVoiceHistoryOwner(batch.owner, input.owner) && !input.excludeCallIds?.has(batch.callId),
  );
  const calls = new Map<string, VoiceHistoryPendingBatch[]>();
  for (const batch of pending) calls.set(batch.callId, [...(calls.get(batch.callId) ?? []), batch]);
  let sent = 0;
  const errors: string[] = [];
  for (const [callId, unordered] of calls) {
    const batches = [...unordered].sort(
      (left, right) => lastFragmentSequence(left) - lastFragmentSequence(right),
    );
    const threadId = batches[0]!.threadId;
    let summary: VoiceCallSummary | null;
    try {
      summary = await input.client.readCall({ threadId, callId });
    } catch (cause) {
      errors.push(`Voice history for an earlier call is still waiting: ${errorText(cause)}`);
      continue;
    }
    if (!summary || !summary.ownedByRequester) {
      errors.push(
        "Voice history for an earlier call is still saved in this browser, but this environment does not confirm that it belongs to this connection.",
      );
      continue;
    }
    let boundary = summary.finalSequence;
    if (summary.endedAt !== null && boundary === null) {
      // The server ended the call without the owner's boundary; it accepts no text until one exists.
      const declared = Math.max(summary.lastSequence, lastFragmentSequence(batches.at(-1)!));
      try {
        await input.client.end({ callId, lastSequence: declared });
        boundary = declared;
      } catch (cause) {
        errors.push(`Voice history for an earlier call is still waiting: ${errorText(cause)}`);
        continue;
      }
    }
    for (const batch of batches) {
      if (boundary !== null && lastFragmentSequence(batch) > boundary) {
        errors.push(
          "Some saved voice history is after the call's final boundary, so the environment cannot accept it.",
        );
        break;
      }
      try {
        await input.client.append({
          sessionId: callId,
          batchId: batch.batchId,
          fragments: batch.fragments,
        });
      } catch (cause) {
        errors.push(`Voice history for an earlier call is still waiting: ${errorText(cause)}`);
        break;
      }
      sent++;
      await input.store.remove(batch).catch(() => undefined);
    }
  }
  return { sent, retained: pending.length - sent, errors };
}
