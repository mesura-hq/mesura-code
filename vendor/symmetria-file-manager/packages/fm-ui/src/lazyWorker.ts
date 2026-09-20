/**
 * One worker, started on first use and never torn down.
 *
 * The panel runs three — highlighting, tags and waveforms — and every one of
 * them wants the same three properties, which is why this is shared rather than
 * written out per consumer:
 *
 * - **Lazy**, so a session that previews no code, no audio and no artwork never
 *   pays to start any of them.
 * - **Shared**, because these panes run on nearly every cursor settle and
 *   spawning a worker per file costs more than the work inside it.
 * - **Forgettable**, because a test must not inherit another test's worker —
 *   the same reason `forgetPreviewTokens` exists in the main process.
 *
 * It also has to survive a host with no workers at all: the panel is embeddable
 * and `Worker` may simply not be there. Every consumer treats `null` as "do the
 * cheap thing instead", never as an error.
 */
export interface LazyWorker<W> {
  /** The worker, or `null` where this host has none. */
  get(): W | null;
  /** Drop it. For tests. */
  forget(): void;
}

/**
 * Generic over what `create` returns rather than fixed to `Worker`, so a caller
 * gets back exactly the type it constructed. That is not a convenience: fixing
 * it to `Worker` forced every test double through an `as unknown as Worker`
 * chain, which is a gating lint error here and, more to the point, throws away
 * the type evidence a double is supposed to carry.
 *
 * @param create builds the worker. A thunk rather than a URL, because
 *   `new URL("./x.worker.ts", import.meta.url)` has to be evaluated in the
 *   MODULE THAT OWNS the worker file for the bundler to see it at all. Passing
 *   the URL in from here would resolve it against this file instead.
 */
export function lazyWorker<W extends { terminate(): void }>(create: () => W): LazyWorker<W> {
  let worker: W | null = null;

  return {
    get() {
      if (worker !== null) return worker;
      if (typeof Worker === "undefined") return null;

      worker = create();
      return worker;
    },
    forget() {
      worker?.terminate();
      worker = null;
    },
  };
}
