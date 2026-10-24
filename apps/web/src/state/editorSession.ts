import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { subscribe, type EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import { WS_METHODS, type EditorSessionInputResult, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  applyEditorSessionEvent,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorSessionState,
} from "./editorSessionFold.ts";
import { batchLength, splitKeysToLimit } from "./editorKeyBatches.ts";

/**
 * The thread's embedded Neovim, as the web client sees it.
 *
 * Web-local rather than in the shared client package, for the same reason
 * `projectFileWatch` is: mobile has no Monaco, so a family defined in the
 * shared package would offer a client an editor it cannot draw.
 */

export {
  applyEditorSessionEvent,
  applyLinesEvent,
  EMPTY_EDITOR_SESSION_STATE,
  type EditorSessionState,
} from "./editorSessionFold.ts";

const editorThreadKey = ({
  environmentId,
  input,
}: {
  readonly environmentId: string;
  readonly input: { readonly threadId: string };
}) => JSON.stringify([environmentId, input.threadId]);

const keyScheduler = createAtomCommandScheduler();
const lifecycleScheduler = createAtomCommandScheduler();

/**
 * The calls that drive Neovim go in order, per thread.
 *
 * Not an optimisation — a correctness requirement. `d` and `w` are one command
 * and two messages; delivered out of order they are two commands, and the
 * second is a motion that moves the cursor rather than the operator's target.
 *
 * Keys do not reach this scheduler one by one: `editorKeyLane` below sends
 * them, coalescing every key typed while a request is in flight into the next
 * request, so a burst costs one round trip instead of one per key. Each batch
 * carries a sequence number, which lets the lane re-send a batch whose reply
 * it lost and the server skip it if Neovim already has it. The scheduler
 * still orders the lane's calls against anything else on the key lane.
 */
const serialPerThread = { mode: "serial" as const, key: editorThreadKey };

export const editorSessionAttach = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editor-session:attach",
  subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.editorSessionAttach>) =>
    subscribe(WS_METHODS.editorSessionAttach, input).pipe(
      Stream.scan((): EditorSessionState => EMPTY_EDITOR_SESSION_STATE, applyEditorSessionEvent),
    ),
  // Long enough to survive the panel's per-file remount, short enough that a
  // closed file does not hold a Neovim's attention for minutes. The default of
  // five minutes would do exactly that.
  idleTtlMs: 5_000,
});

export const editorSessionOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:open",
  tag: WS_METHODS.editorSessionOpen,
  scheduler: lifecycleScheduler,
  concurrency: serialPerThread,
});

export const editorSessionInput = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:input",
  tag: WS_METHODS.editorSessionInput,
  scheduler: keyScheduler,
  concurrency: serialPerThread,
});

export const editorSessionViewport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:viewport",
  tag: WS_METHODS.editorSessionViewport,
  // Only the latest matters: a scroll that has been superseded is a frame
  // nobody will ever see.
  concurrency: { mode: "latest", key: editorThreadKey },
});

export const editorSessionSetCursor = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:set-cursor",
  tag: WS_METHODS.editorSessionSetCursor,
  scheduler: keyScheduler,
  concurrency: serialPerThread,
});

export const editorSessionReplaceText = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:replace-text",
  tag: WS_METHODS.editorSessionReplaceText,
  scheduler: keyScheduler,
  concurrency: serialPerThread,
});

export const editorSessionClose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:close",
  tag: WS_METHODS.editorSessionClose,
  scheduler: lifecycleScheduler,
  concurrency: serialPerThread,
});

/**
 * Whether typed keys are reaching Neovim: `retrying` while a batch failed and
 * is being sent again, `lost` once the lane gave up on them. The status strip
 * shows both.
 */
export type EditorKeysDelivery = "retrying" | "lost" | null;

const keysDeliveryFamily = Atom.family((_key: string) =>
  Atom.make<EditorKeysDelivery>(null).pipe(Atom.keepAlive),
);

export const editorKeysDeliveryAtom = (target: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) =>
  keysDeliveryFamily(
    editorThreadKey({ environmentId: target.environmentId, input: { threadId: target.threadId } }),
  );

/** First retry delay after a failed batch; doubled per failure, up to the cap. */
const KEY_RETRY_FIRST_MS = 250;
const KEY_RETRY_MAX_MS = 4_000;
/** Failures in a row the server answered before the lane drops its keys and reports them lost. */
const KEY_ATTEMPTS = 6;
/**
 * How long the lane waits for a lost connection to come back before it
 * reports the keys lost. A reconnect normally takes a few seconds; a minute
 * covers a laptop waking or a phone changing network, and is still short
 * enough that keys typed into a host that is really gone do not wait forever.
 */
const SESSION_OUTAGE_LIMIT_MS = 60_000;

/**
 * Waits for the environment's RPC session after a request failed on the wire.
 *
 * When the session still reads as connected the socket is usually about to be
 * replaced, so this pauses for `pauseMs` — but a session that drops meanwhile
 * ends the pause, and the wait goes on until one is back, at most `waitMs`.
 * The lane therefore re-sends on the session's return, never on a timer that
 * has backed off past it. `connected` means the pause ran out with the
 * session still there, `reconnected` that a session came back, `unreachable`
 * that none did within the wait.
 */
const editorSessionReachable = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:editor-session:reachable",
  execute: (input: { readonly waitMs: number; readonly pauseMs: number }) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      if (Option.isSome(yield* SubscriptionRef.get(supervisor.session))) {
        const dropped = yield* SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filter(Option.isNone),
          Stream.runHead,
          Effect.timeoutOption(input.pauseMs),
        );
        if (Option.isNone(dropped)) return "connected";
      }
      const back = yield* SubscriptionRef.changes(supervisor.session).pipe(
        Stream.filter(Option.isSome),
        Stream.runHead,
        Effect.timeoutOption(input.waitMs),
      );
      return Option.isSome(back) ? "reconnected" : "unreachable";
    }),
});

/**
 * A failure of the connection rather than an answer from the server. An
 * interruption counts: a session torn down by a closing socket interrupts the
 * requests it still had in flight.
 */
const isTransportFailure = (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure") return false;
  if (isAtomCommandInterrupted(result)) return true;
  const tag = failureTag(result);
  return tag === "EnvironmentRpcUnavailableError" || tag === "RpcClientError";
};

/** The `_tag` of a failed command's error, when it has one. */
function failureTag(result: AtomCommandResult<unknown, unknown>): unknown {
  if (result._tag !== "Failure") return null;
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
}

type KeyLaneEntry =
  | { readonly kind: "keys"; readonly keys: string }
  | { readonly kind: "call"; readonly run: () => Promise<AtomCommandResult<unknown, unknown>> };

export interface EditorKeyLane {
  /** Queues keys in Neovim notation. */
  readonly keys: (keys: string) => void;
  /** Queues a call that must land between the keys around it: a click, an agent's edit. */
  readonly call: (run: () => Promise<AtomCommandResult<unknown, unknown>>) => void;
  /**
   * Whether Neovim is known to be at rest in plain normal mode: nothing is
   * queued or in flight, and the last batch's answer said `n`, not blocking,
   * no flash label. Escape releases the editor only then; otherwise it is a
   * key Neovim has to get.
   *
   * Only an answer confirms: a batch's, read after the keys ran, or an
   * `open`'s (`openBegins`). A snapshot never does: it can be older than the
   * last answer, and it carries no `blocking`, so a reattach while `f` waits
   * would read as resting.
   */
  readonly restsInNormalMode: () => boolean;
  /**
   * Marks an `editorSession.open` about to be sent. Its answer's `escape` is
   * taken (`takeOpenAnswer`) only if the lane was idle now and queues nothing
   * until the answer lands, so the answer is newer than anything the lane
   * knows. Without it Escape right after opening a file would go to Neovim.
   */
  readonly openBegins: () => OpenMark;
  readonly takeOpenAnswer: (mark: OpenMark, escape: EditorSessionInputResult | undefined) => void;
}

/** What `openBegins` saw: the lane's activity count, or null when it was busy. */
export type OpenMark = number | null;

const keyLanes = new WeakMap<AtomRegistry.AtomRegistry, Map<string, EditorKeyLane>>();

/**
 * The one sender of a thread's keys.
 *
 * At most one request is in flight. Keys typed meanwhile wait, and go out
 * together as the next batch once it settles, cut at key boundaries to the
 * contract's bound. A batch that fails is kept and sent again, exactly as it
 * was and under the same sequence number, before anything after it: a
 * disconnect may have lost only the reply, and the server skips a batch it
 * already applied. After a connection failure the lane waits for the session
 * to come back, for up to `SESSION_OUTAGE_LIMIT_MS`, and keys typed meanwhile
 * queue behind the batch. After a failure the server answered, it re-sends on
 * a backoff and at once when another key is typed. Either way, keys it cannot
 * deliver are dropped and reported `lost` rather than vanishing.
 *
 * Module-level per registry rather than per component, because the panel
 * remounts per file and the keys in flight belong to the thread, not the view.
 */
export function editorKeyLane(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly threadId: string },
): EditorKeyLane {
  const key = editorThreadKey({
    environmentId: target.environmentId,
    input: { threadId: target.threadId },
  });
  let lanes = keyLanes.get(registry);
  if (lanes === undefined) {
    lanes = new Map();
    keyLanes.set(registry, lanes);
  }
  const existing = lanes.get(key);
  if (existing !== undefined) return existing;
  const lane = makeKeyLane(registry, target, keysDeliveryFamily(key));
  lanes.set(key, lane);
  return lane;
}

function makeKeyLane(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly threadId: string },
  deliveryAtom: Atom.Writable<EditorKeysDelivery>,
): EditorKeyLane {
  // Names this client's batches. Not `crypto.randomUUID`: a phone reaching
  // the host over plain HTTP is not a secure context and does not have it.
  const laneId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const queue: KeyLaneEntry[] = [];
  let unacknowledged: { readonly keys: string; readonly index: number } | null = null;
  let nextIndex = 0;
  let busy = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while the connection is down: keys typed meanwhile only queue. */
  let waitingForSession = false;
  let outageStartedAt: number | null = null;
  let transportRetries = 0;
  /** Where Neovim said it was after the last batch it answered; null when unknown. */
  let confirmed: EditorSessionInputResult | null = null;
  /** Bumped by every key and call queued, so an open's answer can tell it is the newest. */
  let activity = 0;

  const pending = () => busy || waitingForSession || unacknowledged !== null || queue.length > 0;

  const setDelivery = (delivery: EditorKeysDelivery) => {
    if (registry.get(deliveryAtom) !== delivery) registry.set(deliveryAtom, delivery);
  };

  const sendBatch = async (batch: { readonly keys: string; readonly index: number }) => {
    busy = true;
    const result = await runAtomCommand(
      registry,
      editorSessionInput,
      {
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          keys: batch.keys,
          sequence: { lane: laneId, index: batch.index },
        },
      },
      { label: "editor session input" },
    );
    busy = false;
    if (result._tag === "Success") {
      // Empty from a host older than answers that carry the mode: unknown.
      // Against such a host Escape stays Neovim's; the pane chords leave.
      confirmed = result.value ?? null;
      unacknowledged = null;
      failures = 0;
      outageStartedAt = null;
      transportRetries = 0;
      setDelivery(null);
      pump();
      return;
    }
    if (isTransportFailure(result)) {
      void awaitSession();
      return;
    }
    // The server cannot vouch for this batch (its Neovim restarted after
    // taking it), so resending could type it twice: it is reported lost.
    if (failureTag(result) === "EditorSessionInputLostError") {
      giveUp();
      return;
    }
    failures += 1;
    if (failures >= KEY_ATTEMPTS) {
      giveUp();
      return;
    }
    setDelivery("retrying");
    retryTimer = setTimeout(
      pump,
      Math.min(KEY_RETRY_MAX_MS, KEY_RETRY_FIRST_MS * 2 ** (failures - 1)),
    );
  };

  /** Drops the keys the lane could not deliver, and says so. */
  const giveUp = () => {
    // Keys that may or may not have run leave Neovim's mode unknown.
    confirmed = null;
    unacknowledged = null;
    failures = 0;
    outageStartedAt = null;
    transportRetries = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]?.kind === "keys") queue.splice(index, 1);
    }
    setDelivery("lost");
    pump();
  };

  /**
   * After a connection failure: wait for the session rather than retry into a
   * socket that is reconnecting, which only spends the retry budget. The
   * outage is bounded by time, not attempts — see `SESSION_OUTAGE_LIMIT_MS`.
   */
  const awaitSession = async () => {
    waitingForSession = true;
    setDelivery("retrying");
    outageStartedAt ??= Date.now();
    transportRetries += 1;
    const remaining = SESSION_OUTAGE_LIMIT_MS - (Date.now() - outageStartedAt);
    const reachable =
      remaining <= 0
        ? null
        : await runAtomCommand(
            registry,
            editorSessionReachable,
            {
              environmentId: target.environmentId,
              input: {
                waitMs: remaining,
                pauseMs: Math.min(
                  KEY_RETRY_MAX_MS,
                  KEY_RETRY_FIRST_MS * 2 ** (transportRetries - 1),
                ),
              },
            },
            { label: "editor session reachable" },
          );
    waitingForSession = false;
    const state = reachable?._tag === "Success" ? reachable.value : "unreachable";
    if (state === "unreachable") {
      giveUp();
      return;
    }
    pump();
  };

  const pump = (): void => {
    if (busy || waitingForSession) return;
    clearTimeout(retryTimer);
    if (unacknowledged !== null) {
      void sendBatch(unacknowledged);
      return;
    }
    const head = queue[0];
    if (head === undefined) return;
    if (head.kind === "call") {
      queue.shift();
      busy = true;
      const done = () => {
        busy = false;
        pump();
      };
      void head.run().then(done, done);
      return;
    }
    let keysAhead = 0;
    while (queue[keysAhead]?.kind === "keys") keysAhead += 1;
    const units = queue
      .slice(0, keysAhead)
      .map((entry) => (entry.kind === "keys" ? entry.keys : ""));
    const count = batchLength(units);
    queue.splice(0, count);
    unacknowledged = { keys: units.slice(0, count).join(""), index: nextIndex };
    nextIndex += 1;
    void sendBatch(unacknowledged);
  };

  return {
    keys: (keys) => {
      activity += 1;
      for (const piece of splitKeysToLimit(keys)) queue.push({ kind: "keys", keys: piece });
      pump();
    },
    call: (run) => {
      activity += 1;
      queue.push({ kind: "call", run });
      pump();
    },
    openBegins: () => (pending() ? null : activity),
    takeOpenAnswer: (mark, escape) => {
      // Empty from an older host: unknown, as an empty batch answer is.
      if (mark === null || escape === undefined) return;
      if (activity !== mark || pending()) return;
      confirmed = escape;
    },
    restsInNormalMode: () =>
      !pending() &&
      confirmed !== null &&
      confirmed.mode === "n" &&
      !confirmed.blocking &&
      !confirmed.jumping,
  };
}
