import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { listVoiceCalls, listVoiceTranscript } from "@t3tools/client-runtime/voice-conversation";
import { type ScopedThreadRef, VOICE_WS_METHODS, type VoiceCallSummary } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { runtime } from "~/lib/runtime";
import { cn } from "~/lib/utils";
import { readPreparedConnection } from "~/state/session";
import {
  createVoiceHistoryReadQueue,
  createVoiceTranscriptReader,
  foldVoiceHistoryNotice,
  initialVoiceHistoryNotices,
  planVoiceHistoryRefresh,
  type VoiceHistoryHandled,
  type VoiceHistoryNotices,
  type VoiceTranscriptSnapshot,
} from "./voiceHistoryState";

const CALLS_PAGE_SIZE = 20;
const TRANSCRIPT_PAGE_SIZE = 100;
/** A summary-only read: past any saved fragment, so the response carries just the call. */
const SUMMARY_ONLY_AFTER_SEQUENCE = Number.MAX_SAFE_INTEGER;

let voiceHistorySubscriptions = 0;

/**
 * Change notices for the open viewer, folded as they arrive. The atom keeps only its latest value,
 * so the fold is what keeps two calls that change in one React batch both dirty. Each stream start
 * is a new subscription; five seconds of idle covers a remount without keeping the server stream.
 */
const voiceHistoryNotices = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:voice-history:notices",
  tag: VOICE_WS_METHODS.subscribeVoiceHistory,
  idleTtlMs: 5_000,
  transform: (stream) =>
    Stream.suspend(() => {
      voiceHistorySubscriptions += 1;
      const generation = voiceHistorySubscriptions;
      return stream.pipe(
        Stream.scan(() => initialVoiceHistoryNotices(generation), foldVoiceHistoryNotice),
        Stream.drop(1),
      );
    }),
});

const END_REASON_LABELS: Record<NonNullable<VoiceCallSummary["endReason"]>, string> = {
  hangup: "Ended",
  interrupted: "Interrupted",
  expired: "Connection lost",
  "max-duration": "15-minute limit",
};

/** Whether everything the owner said it recorded has reached the environment. */
function savedState(call: VoiceCallSummary): string {
  if (call.endedAt === null) return "In progress";
  if (call.finalSequence !== null && call.lastSequence >= call.finalSequence) return "Saved";
  return call.endReason === "hangup" ? "Saving…" : "Partly saved";
}

function callState(call: VoiceCallSummary): string {
  return `${call.endReason ? END_REASON_LABELS[call.endReason] : "Live"} · ${savedState(call)}`;
}

function formatStartedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Voice history could not be loaded. Try again.";
}

/** Replaces known calls with fresher summaries, keeping the order and the calls not in `fresh`. */
function withSummaries(
  current: ReadonlyArray<VoiceCallSummary>,
  fresh: ReadonlyArray<VoiceCallSummary>,
): ReadonlyArray<VoiceCallSummary> {
  const byId = new Map(fresh.map((call) => [call.callId, call]));
  return current.map((call) => byId.get(call.callId) ?? call);
}

/**
 * The thread's saved voice conversations. It only reads: opening it, or any call in it, never
 * starts audio, sends a request or changes the thread's turns, from this browser or any other.
 * It reads when it opens, re-reads everything shown after a (re)subscription or an overflow
 * resync, and otherwise re-reads only what a typed notice names.
 */
export function VoiceHistoryPanel({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const [calls, setCalls] = useState<ReadonlyArray<VoiceCallSummary>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed by call, so a snapshot of the previously selected call is never shown for another one.
  const [readerState, setReaderState] = useState<{
    readonly callId: string;
    readonly snapshot: VoiceTranscriptSnapshot;
  } | null>(null);
  const firstPageIdsRef = useRef<ReadonlyArray<string>>([]);
  const readerRef = useRef<ReturnType<typeof createVoiceTranscriptReader> | null>(null);
  const [readQueue] = useState(createVoiceHistoryReadQueue);
  // Queued reads need the preceding response before React commits its render.
  const listRef = useRef({ calls, nextCursor });
  const applyCalls = useStableCallback(
    (update: (current: ReadonlyArray<VoiceCallSummary>) => ReadonlyArray<VoiceCallSummary>) => {
      const next = update(listRef.current.calls);
      listRef.current = { ...listRef.current, calls: next };
      setCalls(next);
    },
  );
  const applyCursor = (cursor: string | null) => {
    listRef.current = { ...listRef.current, nextCursor: cursor };
    setNextCursor(cursor);
  };

  const readPage = async (cursor: string | null) => {
    const prepared = readPreparedConnection(environmentId);
    if (!prepared) throw new Error("Connect to this environment to read its voice conversations.");
    return runtime.runPromise(
      listVoiceCalls(prepared, {
        threadId,
        ...(cursor === null ? {} : { cursor }),
        limit: CALLS_PAGE_SIZE,
      }),
    );
  };

  // No try/finally: React Compiler cannot compile it and would skip this whole component.
  const report = async (read: () => Promise<void>) => {
    const failure = await readQueue.read(read).then(
      () => null,
      (cause: unknown) => errorMessage(cause),
    );
    setError(failure);
    setLoading(false);
  };

  /** The newest page; older pages already loaded stay, with this page's fresher summaries. */
  // Stable: the mount read and the notice handler start it after a commit.
  const readFirstPage = useStableCallback(() =>
    report(async () => {
      const page = await readPage(null);
      const olderPagesLoaded = listRef.current.calls.length > page.calls.length;
      firstPageIdsRef.current = page.calls.map((call) => call.callId);
      applyCalls((current) => [
        ...page.calls,
        ...current.filter((call) => !page.calls.some((fresh) => fresh.callId === call.callId)),
      ]);
      if (!olderPagesLoaded) applyCursor(page.nextCursor);
    }),
  );

  /** Every page shown so far, read again: a gap in notices may have changed any of them. */
  const resyncLoadedPages = () =>
    report(async () => {
      const wanted = Math.max(listRef.current.calls.length, 1);
      const fresh: VoiceCallSummary[] = [];
      let cursor: string | null = null;
      do {
        const page = await readPage(cursor);
        if (fresh.length === 0) firstPageIdsRef.current = page.calls.map((call) => call.callId);
        fresh.push(...page.calls);
        cursor = page.nextCursor;
      } while (cursor !== null && fresh.length < wanted);
      applyCalls(() => fresh);
      applyCursor(cursor);
    });

  /** One older call's summary, which the first page does not cover. */
  const readSummary = (callId: string) =>
    report(async () => {
      const prepared = readPreparedConnection(environmentId);
      if (!prepared) return;
      const page = await runtime.runPromise(
        listVoiceTranscript(prepared, {
          threadId,
          callId,
          afterSequence: SUMMARY_ONLY_AFTER_SEQUENCE,
          limit: 1,
        }),
      );
      applyCalls((current) => withSummaries(current, [page.call]));
    });

  const readOlder = () =>
    report(async () => {
      const cursor = listRef.current.nextCursor;
      if (cursor === null) return;
      const page = await readPage(cursor);
      applyCalls((current) => [
        ...current,
        ...page.calls.filter((call) => !current.some((known) => known.callId === call.callId)),
      ]);
      applyCursor(page.nextCursor);
    });

  // One serialized reader per selected call. Its responses carry the call's authoritative
  // summary, which also refreshes that call's entry in the list, wherever it was loaded from.
  // oxlint-disable-next-line t3code/react-effect-budget -- owns the selected call's serialized transcript reader
  useEffect(() => {
    if (selectedId === null) return;
    const reader = createVoiceTranscriptReader({
      read: (afterSequence) =>
        readQueue.read(async () => {
          const prepared = readPreparedConnection(environmentId);
          if (!prepared) throw new Error("Connect to this environment to read this conversation.");
          const page = await runtime.runPromise(
            listVoiceTranscript(prepared, {
              threadId,
              callId: selectedId,
              ...(afterSequence === null ? {} : { afterSequence }),
              limit: TRANSCRIPT_PAGE_SIZE,
            }),
          );
          applyCalls((current) => withSummaries(current, [page.call]));
          return page;
        }),
      onUpdate: (snapshot) => {
        setReaderState({ callId: selectedId, snapshot });
      },
      describeError: errorMessage,
    });
    readerRef.current = reader;
    void reader.request();
    return () => {
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [environmentId, threadId, selectedId, readQueue, applyCalls]);

  // ChatView keys this panel by thread, so this reads each thread's first page once.
  // oxlint-disable-next-line t3code/react-effect-budget -- reads the thread's first page from the environment
  useEffect(() => {
    void readFirstPage();
  }, [readFirstPage]);

  const notices = Option.getOrNull(
    AsyncResult.value(useAtomValue(voiceHistoryNotices({ environmentId, input: { threadId } }))),
  ) as VoiceHistoryNotices | null;
  const handledRef = useRef<VoiceHistoryHandled | null>(null);
  // Stable, so the effect below runs per notice value; it still reads this render's calls.
  const handleNotices = useStableCallback((notices: VoiceHistoryNotices) => {
    const plan = planVoiceHistoryRefresh({
      notices,
      previous: handledRef.current,
      selectedCallId: selectedId,
      firstPageCallIds: firstPageIdsRef.current,
      loadedCallIds: calls.map((call) => call.callId),
    });
    handledRef.current = plan.handled;
    if (plan.resync) void resyncLoadedPages();
    else if (plan.refreshFirstPage) void readFirstPage();
    for (const callId of plan.summaryCallIds) void readSummary(callId);
    if (plan.readSelected) void readerRef.current?.request();
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- reacts to the environment's notice stream
  useEffect(() => {
    if (notices !== null) handleNotices(notices);
  }, [notices, handleNotices]);

  const transcript = readerState?.callId === selectedId ? readerState.snapshot : null;
  const listed = calls.find((call) => call.callId === selectedId) ?? null;
  const selected = listed ?? transcript?.call;

  return (
    <section
      aria-label="Voice conversations"
      className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="max-sm:h-11"
          onClick={selected ? () => setSelectedId(null) : onClose}
        >
          <ArrowLeft aria-hidden /> {selected ? "All conversations" : "Back to thread"}
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Voice conversations</h2>
        {selected ? (
          <Button size="sm" variant="ghost" className="max-sm:h-11" onClick={onClose}>
            Back to thread
          </Button>
        ) : null}
      </header>
      {error ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {selected ? (
        <VoiceCallTranscriptHistory
          call={selected}
          transcript={transcript}
          onLoadMore={() => void readerRef.current?.request()}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Loading conversations…</p>
          ) : calls.length === 0 && !error ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No saved voice conversations in this thread.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {calls.map((call) => (
                <li key={call.callId}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                    onClick={() => setSelectedId(call.callId)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {formatStartedAt(call.startedAt)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {callState(call)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {nextCursor !== null ? (
            <div className="flex justify-center p-3">
              <Button size="sm" variant="outline" onClick={() => void readOlder()}>
                Load older conversations
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** One saved call's transcript, as its serialized reader last published it. */
function VoiceCallTranscriptHistory({
  call,
  transcript,
  onLoadMore,
}: {
  call: VoiceCallSummary;
  transcript: VoiceTranscriptSnapshot | null;
  onLoadMore: () => void;
}) {
  const fragments = transcript?.fragments ?? [];
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        {formatStartedAt(call.startedAt)} · {callState(call)}
      </p>
      {transcript?.error ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive-foreground">
          {transcript.error}
        </p>
      ) : null}
      {transcript === null || transcript.loading ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Loading transcript…</p>
      ) : fragments.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No saved text for this call.</p>
      ) : (
        <ol className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
          {fragments.map((fragment) => (
            <li
              key={fragment.fragmentId}
              className={cn(
                "min-w-0 text-base leading-7 whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
                fragment.speaker === "user" && "ml-8 self-end rounded-2xl bg-muted/70 px-4 py-2",
              )}
            >
              <span className="sr-only">{fragment.speaker === "user" ? "You: " : "Agent: "}</span>
              {fragment.text}
            </li>
          ))}
        </ol>
      )}
      {transcript?.hasMore ? (
        <div className="flex justify-center p-3">
          <Button size="sm" variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
