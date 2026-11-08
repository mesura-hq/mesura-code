/**
 * The generation is minted once per mount and tells the main process a reload happened:
 * state after a reload has no relation to state before, so the publisher answers a new
 * generation with a whole snapshot instead of continuing the delta sequence.
 */
import { useEffect, useRef } from "react";

import {
  buildFeedPayload,
  feedReadModelKey,
  type FeedProject,
  type FeedThread,
} from "./threadFeed";

/** A value that changes on every mount and never within one. */
const mintGeneration = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useThreadFeed(input: {
  readonly projects: readonly FeedProject[];
  readonly threads: readonly FeedThread[];
}): void {
  const generation = useRef<string | null>(null);
  if (generation.current === null) generation.current = mintGeneration();
  const lastSent = useRef<string | null>(null);

  const { projects, threads } = input;

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: synchronizes the projected thread list to the Electron main process
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
    // One serialization per push: the comparison and the record share it.
    const readModelKey = feedReadModelKey(payload);
    if (lastSent.current !== null && readModelKey === lastSent.current) return;

    lastSent.current = readModelKey;
    // Fire and forget. The answer carries nothing, and a rejection means the
    // main process has no publisher — which is not something the renderer can
    // act on, and not worth a console entry per push.
    void publish(payload).catch(() => {});
  }, [projects, threads]);
}
