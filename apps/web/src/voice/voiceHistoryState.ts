import type {
  VoiceCallSummary,
  VoiceHistoryStreamItem,
  VoiceTranscriptFragment,
} from "@t3tools/contracts";

/**
 * Accumulated notices of one subscription. The subscription atom keeps only its latest value, so
 * notices are folded into this value before they reach it: two calls that change before React
 * reads the atom both stay dirty. Each call keeps its highest notice sequence.
 */
export interface VoiceHistoryNotices {
  /** Distinct per subscription stream, so a reconnect is a new subscription. */
  readonly subscription: number;
  /** `subscribed` receipts and overflow `resync` notices seen on this subscription. */
  readonly resyncs: number;
  readonly calls: ReadonlyMap<string, number>;
}

export function initialVoiceHistoryNotices(subscription: number): VoiceHistoryNotices {
  return { subscription, resyncs: 0, calls: new Map() };
}

export function foldVoiceHistoryNotice(
  notices: VoiceHistoryNotices,
  item: VoiceHistoryStreamItem,
): VoiceHistoryNotices {
  if (item.kind !== "call-changed") return { ...notices, resyncs: notices.resyncs + 1 };
  if ((notices.calls.get(item.callId) ?? -1) >= item.sequence) return notices;
  const calls = new Map(notices.calls);
  calls.set(item.callId, item.sequence);
  return { ...notices, calls };
}

/** What the viewer has already acted on; compare the next fold against it. */
export interface VoiceHistoryHandled {
  readonly subscription: number;
  readonly resyncs: number;
  readonly calls: ReadonlyMap<string, number>;
}

export interface VoiceHistoryRefreshPlan {
  /** Re-read everything shown: the first page, the older pages loaded and the selected call. */
  readonly resync: boolean;
  readonly readSelected: boolean;
  /** Loaded calls beyond the first page whose summary changed. */
  readonly summaryCallIds: ReadonlyArray<string>;
  readonly refreshFirstPage: boolean;
  readonly handled: VoiceHistoryHandled;
}

/**
 * The reads a new notice fold calls for. A new subscription or another resync re-reads all that
 * is shown, the selected call included wherever it sits in the list. A call notice re-reads the
 * first page, the selected call's transcript, or the summary of an older loaded call.
 */
export function planVoiceHistoryRefresh(input: {
  readonly notices: VoiceHistoryNotices;
  readonly previous: VoiceHistoryHandled | null;
  readonly selectedCallId: string | null;
  readonly firstPageCallIds: ReadonlyArray<string>;
  readonly loadedCallIds: ReadonlyArray<string>;
}): VoiceHistoryRefreshPlan {
  const { notices, previous, selectedCallId } = input;
  const handled: VoiceHistoryHandled = {
    subscription: notices.subscription,
    resyncs: notices.resyncs,
    calls: notices.calls,
  };
  const resync =
    previous === null ||
    previous.subscription !== notices.subscription ||
    previous.resyncs !== notices.resyncs;
  if (resync)
    return {
      resync: true,
      readSelected: selectedCallId !== null,
      summaryCallIds: [],
      refreshFirstPage: true,
      handled,
    };
  const dirty = [...notices.calls].flatMap(([callId, sequence]) =>
    (previous.calls.get(callId) ?? -1) < sequence ? [callId] : [],
  );
  const firstPage = new Set(input.firstPageCallIds);
  const loaded = new Set(input.loadedCallIds);
  return {
    resync: false,
    readSelected: selectedCallId !== null && dirty.includes(selectedCallId),
    summaryCallIds: dirty.filter(
      (callId) => callId !== selectedCallId && loaded.has(callId) && !firstPage.has(callId),
    ),
    refreshFirstPage: dirty.length > 0,
    handled,
  };
}

export interface VoiceTranscriptPage {
  readonly call: VoiceCallSummary;
  readonly fragments: ReadonlyArray<VoiceTranscriptFragment>;
  readonly nextAfterSequence: number | null;
}

export interface VoiceTranscriptSnapshot {
  readonly fragments: ReadonlyArray<VoiceTranscriptFragment>;
  /** The summary the latest transcript response returned; authoritative for this call. */
  readonly call: VoiceCallSummary | null;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * The only reader of one call's transcript. Reads run one at a time from a cursor that only moves
 * forward. A request made while a read runs is kept and served when it finishes, so a notice or
 * Load more is never lost and an older response can never overwrite a newer one. `request`
 * resolves once every request made so far has been served: the caller's drain receipt.
 */
export function createVoiceTranscriptReader(input: {
  readonly read: (afterSequence: number | null) => Promise<VoiceTranscriptPage>;
  readonly onUpdate: (snapshot: VoiceTranscriptSnapshot) => void;
  readonly describeError?: (cause: unknown) => string;
}) {
  let snapshot: VoiceTranscriptSnapshot = {
    fragments: [],
    call: null,
    hasMore: false,
    loading: true,
    error: null,
  };
  let cursor: number | null = null;
  let pending = false;
  let running: Promise<void> | null = null;
  let disposed = false;

  const publish = (next: Partial<VoiceTranscriptSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...next };
    input.onUpdate(snapshot);
  };

  const apply = (page: VoiceTranscriptPage) => {
    const fresh = page.fragments.filter((fragment) => fragment.sequence > (cursor ?? 0));
    const last = fresh.at(-1)?.sequence;
    if (last !== undefined) cursor = last;
    publish({
      fragments: fresh.length > 0 ? [...snapshot.fragments, ...fresh] : snapshot.fragments,
      call: page.call,
      hasMore: page.nextAfterSequence !== null,
      loading: false,
      error: null,
    });
  };

  const drain = async () => {
    try {
      while (pending) {
        // A closed call stops reading; its responses are ignored below.
        if (disposed) break;
        pending = false;
        try {
          const page = await input.read(cursor);
          if (!disposed) apply(page);
        } catch (cause) {
          publish({
            loading: false,
            error: input.describeError ? input.describeError(cause) : String(cause),
          });
        }
      }
    } finally {
      // Cleared in the same step as the last `pending` check, so a later request starts a new
      // drain instead of joining one that has already finished.
      running = null;
    }
  };

  return {
    request(): Promise<void> {
      if (disposed) return Promise.resolve();
      pending = true;
      running ??= drain();
      return running;
    },
    snapshot: () => snapshot,
    dispose() {
      disposed = true;
    },
  };
}
