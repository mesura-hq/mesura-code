import type { VoiceCallPage, VoiceCallSummary, VoiceTranscriptPage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { flushBrowserTasks } from "../test/browserTasks";
import { createDeferredPromise } from "../test/threadLinkFixture";

const fixture = vi.hoisted(() => ({
  read: undefined as unknown as () => Promise<VoiceCallPage>,
  readTranscript: undefined as unknown as () => Promise<VoiceTranscriptPage>,
  notices: { subscription: 1, resyncs: 1, calls: new Map<string, number>() },
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => AsyncResult.success(fixture.notices)) as never,
}));
vi.mock(import("@t3tools/client-runtime/voice-conversation"), async (original) => ({
  ...(await original()),
  listVoiceCalls: (() => Effect.promise(() => fixture.read())) as never,
  listVoiceTranscript: (() => Effect.promise(() => fixture.readTranscript())) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => ({})) as never,
}));

import { VoiceHistoryPanel } from "./VoiceHistoryPanel";

const live: VoiceCallSummary = {
  callId: "history-refresh-call-0001",
  threadId: "history-refresh-thread" as VoiceCallSummary["threadId"],
  startedAt: "2026-11-08T19:00:00.000Z",
  endedAt: null,
  endReason: null,
  lastSequence: 0,
  finalSequence: null,
  ownedByRequester: true,
};
const saved: VoiceCallSummary = {
  ...live,
  endedAt: "2026-11-08T19:01:00.000Z",
  endReason: "hangup",
  lastSequence: 1,
  finalSequence: 1,
};

const panel = () => (
  <VoiceHistoryPanel
    threadRef={{ environmentId: "history-refresh-environment" as never, threadId: live.threadId }}
    onClose={() => {}}
  />
);

describe("voice history refresh ordering", () => {
  it("keeps a newer completed summary after the opening read and subscription resync", async () => {
    const started = createDeferredPromise<void>();
    const opening = createDeferredPromise<VoiceCallPage>();
    const refreshed = createDeferredPromise<void>();
    let reads = 0;
    fixture.read = async () => {
      reads += 1;
      if (reads === 1) {
        started.resolve();
        return opening.promise;
      }
      refreshed.resolve();
      return { calls: [saved], nextCursor: null };
    };

    await using screen = await render(panel(), { router: false });
    try {
      await started.promise;
      await act(flushBrowserTasks);
      // The subscription invalidation waits until the opening response applies.
      expect(reads).toBe(1);
      await act(async () => {
        opening.resolve({ calls: [live], nextCursor: null });
        await refreshed.promise;
        await flushBrowserTasks();
      });
      expect(screen.container.textContent).toContain("Ended · Saved");
      expect(screen.container.textContent).not.toContain("Live · In progress");
    } finally {
      opening.resolve({ calls: [live], nextCursor: null });
    }
  });

  it("coordinates a selected transcript summary with a newer list resync", async () => {
    fixture.notices = { subscription: 2, resyncs: 1, calls: new Map() };
    const initialReads = createDeferredPromise<void>();
    const transcriptStarted = createDeferredPromise<void>();
    const transcript = createDeferredPromise<VoiceTranscriptPage>();
    const resynced = createDeferredPromise<void>();
    let reads = 0;
    let transcriptReads = 0;
    fixture.read = async () => {
      reads += 1;
      if (reads === 2) initialReads.resolve();
      if (reads === 3) resynced.resolve();
      return { calls: [reads < 3 ? live : saved], nextCursor: null };
    };
    fixture.readTranscript = () => {
      transcriptReads += 1;
      transcriptStarted.resolve();
      return transcriptReads === 1
        ? transcript.promise
        : Promise.resolve({ call: saved, fragments: [], nextAfterSequence: null });
    };
    await using screen = await render(panel(), { router: false });
    try {
      await act(async () => {
        await initialReads.promise;
        await flushBrowserTasks();
      });
      await screen.getByRole("button", { name: /Live · In progress/ }).click();
      await transcriptStarted.promise;
      fixture.notices = { ...fixture.notices, resyncs: 2 };
      await screen.rerender(panel());
      await act(flushBrowserTasks);
      expect(reads).toBe(2);
      await act(async () => {
        transcript.resolve({ call: live, fragments: [], nextAfterSequence: null });
        await resynced.promise;
        await flushBrowserTasks();
      });
      expect(screen.container.textContent).toContain("Ended · Saved");
      expect(screen.container.textContent).not.toContain("Live · In progress");
    } finally {
      transcript.resolve({ call: live, fragments: [], nextAfterSequence: null });
    }
  });
});
