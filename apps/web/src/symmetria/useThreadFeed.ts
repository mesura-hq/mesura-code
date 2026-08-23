/**
 * Forwards the renderer's projected thread list to the main process.
 *
 * Deliberately thin, like `useSttDelivery` beside it: everything decidable is
 * in `threadFeed.ts`, which is pure and is where the tests are.
 *
 * The generation is minted once per mount and is what tells the main process a
 * reload happened. Its state after a reload has no relationship to the state
 * before, so continuing the delta sequence across that boundary would be the
 * silent gap the contract forbids — the publisher answers a new generation with
 * a whole snapshot instead.
 */
import { useEffect, useRef } from "react";

import { buildFeedPayload, hasFeedChanged, type FeedProject, type FeedThread } from "./threadFeed";

/** A value that changes on every mount and never within one. */
const mintGeneration = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useThreadFeed(input: {
  readonly projects: readonly FeedProject[];
  readonly threads: readonly FeedThread[];
}): void {
  const generation = useRef<string | null>(null);
  generation.current ??= mintGeneration();
  const lastSent = useRef<string | null>(null);

  const { projects, threads } = input;

  useEffect(() => {
    const publish = window.desktopBridge?.publishThreads;
    // Absent on web and on any build without the publisher. The bar is simply
    // not fed there, and nothing else changes.
    if (typeof publish !== "function") return;

    const payload = buildFeedPayload({
      generation: generation.current as string,
      projects,
      threads,
    });

    // The read model updates per streaming token and this projection almost
    // never does, so the comparison keeps the message off the channel entirely
    // rather than letting the main process discard it after the fact.
    const isFirstSend = lastSent.current === null;
    if (!isFirstSend && !hasFeedChanged(lastSent.current, payload)) return;

    lastSent.current = JSON.stringify(payload.readModel);
    // Fire and forget. The answer carries nothing, and a rejection means the
    // main process has no publisher — which is not something the renderer can
    // act on, and not worth a console entry per push.
    void publish(payload).catch(() => {});
  }, [projects, threads]);
}
