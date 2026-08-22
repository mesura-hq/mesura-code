/**
 * Correlates one dictation request with the window's answer.
 *
 * The socket must not reply until delivery resolved, and delivery happens in
 * the renderer, so main sends a request carrying an id and waits for a matching
 * resolution. This is the shape `DesktopSshPasswordPrompts` already uses for the
 * same direction — a pending map keyed by request id — kept in plain TypeScript
 * here so the correlation is testable without Electron or an Effect runtime.
 */
import type { SttOutcome, SttRequest } from "./sttProtocol.ts";

export type SttDeliveryMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly submit: boolean;
};

export type SttBridgeOptions = {
  /**
   * Hands the message to the window. Returns false when there is no window to
   * hand it to, which is a `no-conversation` answer and not a failure.
   */
  readonly send: (message: SttDeliveryMessage) => boolean;
  readonly newRequestId: () => string;
};

/**
 * The id is handed back with the promise so a caller applying a deadline can
 * abandon exactly its own request. Returning only the promise is what made an
 * earlier version reach for `abandonAll` and take every concurrent dictation
 * down with it.
 */
export type SttDispatch = {
  readonly requestId: string;
  readonly answered: Promise<SttOutcome>;
};

export type SttBridge = {
  readonly deliver: (request: SttRequest) => SttDispatch;
  /** Called when the window answers. Unknown or already-settled ids are ignored. */
  readonly resolve: (requestId: string, outcome: SttOutcome) => void;
  /**
   * Answers ONE waiting request. This is what a deadline uses: the map is
   * shared by every dictation in flight, so abandoning all of them because one
   * ran out of time would answer `no-conversation` to a request the window was
   * still about to serve.
   */
  readonly abandonOne: (requestId: string) => void;
  /** Answers every request still waiting. Teardown only. */
  readonly abandonAll: () => void;
};

// No timer here on purpose. The repository routes timers through Effect, and
// the caller already runs inside one — so the deadline belongs to the layer,
// which applies it with Effect's own timeout and calls `abandonAll`.
export function createSttBridge(options: SttBridgeOptions): SttBridge {
  const { send, newRequestId } = options;
  const pending = new Map<string, (outcome: SttOutcome) => void>();

  const settle = (requestId: string, outcome: SttOutcome): void => {
    const resolveOne = pending.get(requestId);
    if (resolveOne === undefined) return;
    pending.delete(requestId);
    resolveOne(outcome);
  };

  return {
    deliver: (request) => {
      const requestId = newRequestId();
      const answered = new Promise<SttOutcome>((resolveDeliver) => {
        const delivered = send({ requestId, text: request.text, submit: request.submit });
        if (!delivered) {
          resolveDeliver({ kind: "no-conversation" });
          return;
        }
        pending.set(requestId, resolveDeliver);
      });
      return { requestId, answered };
    },

    resolve: settle,

    abandonOne: (requestId) => settle(requestId, { kind: "no-conversation" }),

    abandonAll: () => {
      // Take the waiters and clear the map before resolving any of them, so
      // nothing is iterated while it is being mutated.
      const waiting = Array.from(pending.values());
      pending.clear();
      for (const resolveOne of waiting) {
        resolveOne({ kind: "no-conversation" });
      }
    },
  };
}
