import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  appendVoiceTranscript,
  createVoiceHistoryOwnerGuard,
  endVoiceConversation,
  readVoiceCall,
  voiceConversationSettings,
} from "@t3tools/client-runtime/voice-conversation";
import {
  resumeVoiceHistoryOutbox,
  type VoiceHistoryClient,
  type VoiceHistoryOwner,
  type VoiceHistoryPendingBatch,
  type VoiceHistoryPendingStore,
  type VoiceHistoryResumeResult,
} from "@t3tools/client-runtime/voice-conversation/history";
import {
  type EnvironmentId,
  type VoiceConversationSettings,
  VoiceTranscriptFragment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runtime } from "~/lib/runtime";
import {
  openVoiceHistoryOutboxBackend,
  type VoiceHistoryOutboxBackend,
} from "../connection/storage";

const STORAGE_UNAVAILABLE_MESSAGE =
  "This browser cannot save voice history, so a voice call cannot start here. Allow site storage (IndexedDB) and try again.";
const HISTORY_UNSUPPORTED_MESSAGE =
  "This environment cannot save voice history for this connection. Update the environment, or connect with access to operate threads, before starting a voice call.";
const HISTORY_UNVERIFIED_MESSAGE =
  "This browser keeps voice history from an earlier call, but this environment does not confirm that it belongs to this connection, so it was not sent.";
const CONNECTION_CHANGED_MESSAGE =
  "The connection to this environment changed before the call started. Try again.";

const StoredVoiceHistoryBatch = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  owner: Schema.Struct({ environmentId: Schema.String, clientIdentity: Schema.String }),
  threadId: Schema.String,
  callId: Schema.String,
  batchId: Schema.String,
  fragments: Schema.Array(VoiceTranscriptFragment),
});
const decodeStoredBatch = Schema.decodeUnknownOption(StoredVoiceHistoryBatch);

const outboxKey = (batch: VoiceHistoryPendingBatch) =>
  JSON.stringify([
    batch.owner.environmentId,
    batch.owner.clientIdentity,
    batch.callId,
    batch.batchId,
  ]);

const pendingStoreFrom = (backend: VoiceHistoryOutboxBackend): VoiceHistoryPendingStore => ({
  list: () =>
    Effect.runPromise(backend.readAll).then((values) =>
      values.flatMap((value) => {
        // An entry this version cannot read stays in storage; it is never sent.
        const decoded = decodeStoredBatch(value);
        if (decoded._tag === "None") return [];
        const { schemaVersion: _schemaVersion, ...batch } = decoded.value;
        return [batch];
      }),
    ),
  put: (batch) =>
    Effect.runPromise(
      backend.write(outboxKey(batch), {
        schemaVersion: 1,
        owner: {
          environmentId: batch.owner.environmentId,
          clientIdentity: batch.owner.clientIdentity,
        },
        threadId: batch.threadId,
        callId: batch.callId,
        batchId: batch.batchId,
        fragments: batch.fragments,
      }),
    ),
  remove: (batch) => Effect.runPromise(backend.remove(outboxKey(batch))),
});

let openedOutbox: Promise<VoiceHistoryPendingStore> | null = null;

/** Opens the outbox in the connection database. It rejects when this browser cannot store it. */
export function openVoiceHistoryOutbox(): Promise<VoiceHistoryPendingStore> {
  openedOutbox ??= Effect.runPromise(openVoiceHistoryOutboxBackend()).then(pendingStoreFrom, () => {
    openedOutbox = null;
    throw new Error(STORAGE_UNAVAILABLE_MESSAGE);
  });
  return openedOutbox;
}

/**
 * The owner pending text is keyed and sent under: the environment plus the opaque owner it
 * reported for this authenticated connection. Null when it reported none, which means this
 * connection cannot prove ownership of recoverable history.
 */
export function voiceHistoryOwnerFor(input: {
  readonly environmentId: EnvironmentId;
  readonly settings: VoiceConversationSettings | null;
}): VoiceHistoryOwner | null {
  const clientIdentity = input.settings?.historyOwnerId;
  return clientIdentity ? { environmentId: input.environmentId, clientIdentity } : null;
}

/** Who a history client may send for, and for how long. */
export interface VoiceHistoryClientOwner {
  readonly historyOwnerId: string;
  /** False ends the client's lifetime: nothing more is sent. */
  readonly isCurrent: () => boolean;
}

/** The environment routes the outbox uses, bound to one prepared connection. */
export interface VoiceHistoryEnvironment {
  readonly settings: (prepared: PreparedConnection) => Promise<VoiceConversationSettings>;
  /** Every request first proves, with its own authorization, that the owner is unchanged. */
  readonly makeHistoryClient: (
    prepared: PreparedConnection,
    owner: VoiceHistoryClientOwner,
  ) => VoiceHistoryClient;
}

export const voiceHistoryEnvironment: VoiceHistoryEnvironment = {
  settings: (prepared) => runtime.runPromise(voiceConversationSettings(prepared)),
  makeHistoryClient: (prepared, owner) => {
    const guard = createVoiceHistoryOwnerGuard(owner);
    return {
      append: (payload) => runtime.runPromise(appendVoiceTranscript(prepared, payload, guard)),
      readCall: (input) => runtime.runPromise(readVoiceCall(prepared, input, guard)),
      end: ({ callId, lastSequence }) =>
        runtime
          .runPromise(endVoiceConversation(prepared, callId, lastSequence, guard))
          .then(() => undefined),
    };
  },
};

interface VoiceHistoryHostInput {
  readonly environmentId: EnvironmentId;
  readonly readPrepared: () => PreparedConnection | null;
  /** False once the host left this environment or thread; work for it then stops. */
  readonly isCurrent: () => boolean;
  readonly openStore?: () => Promise<VoiceHistoryPendingStore>;
  readonly environment?: VoiceHistoryEnvironment;
}

/**
 * Resolves the authenticated owner for this connection now, after every await checking that
 * the host still targets the same environment. The client stays bound to that connection and
 * owner: each of its requests proves the owner again under its own credential, and stops while
 * `sendWhile` is false.
 */
async function resolveVoiceHistoryOwner(input: VoiceHistoryHostInput, sendWhile: () => boolean) {
  const environment = input.environment ?? voiceHistoryEnvironment;
  const prepared = input.readPrepared();
  if (!prepared || prepared.environmentId !== input.environmentId) return null;
  const settings = await environment.settings(prepared);
  if (!input.isCurrent() || input.readPrepared()?.environmentId !== input.environmentId)
    return null;
  const owner = voiceHistoryOwnerFor({ environmentId: input.environmentId, settings });
  return {
    prepared,
    settings,
    owner,
    historyClient: owner
      ? environment.makeHistoryClient(prepared, {
          historyOwnerId: owner.clientIdentity,
          isCurrent: sendWhile,
        })
      : null,
  };
}

/**
 * Everything a call needs before the microphone is requested: working storage and an owner the
 * environment confirmed. It rejects with the reason a call cannot record history.
 */
export async function prepareVoiceHistory(input: VoiceHistoryHostInput) {
  const store = await (input.openStore ?? openVoiceHistoryOutbox)();
  if (!input.isCurrent()) throw new Error(CONNECTION_CHANGED_MESSAGE);
  // The call's history outlives its view: it finishes after navigation for as long as the
  // environment still confirms the same owner on every request.
  const resolved = await resolveVoiceHistoryOwner(input, () => true);
  if (!resolved) throw new Error(CONNECTION_CHANGED_MESSAGE);
  if (!resolved.owner || !resolved.historyClient) throw new Error(HISTORY_UNSUPPORTED_MESSAGE);
  return { ...resolved, owner: resolved.owner, historyClient: resolved.historyClient, store };
}

/** Calls whose recorder still sends its own batches, even after their panel unmounted. */
const liveVoiceHistoryCalls = new Set<string>();

/** Keeps resume away from a call's batches until its recorder finished. Returns the release. */
export function claimVoiceHistoryCall(callId: string): () => void {
  liveVoiceHistoryCalls.add(callId);
  return () => liveVoiceHistoryCalls.delete(callId);
}

/**
 * Sends the history this browser kept for earlier calls of this owner. Nothing is sent when the
 * environment reports no owner for this connection or the host moved elsewhere meanwhile.
 */
export async function resumePendingVoiceHistory(
  input: VoiceHistoryHostInput & { readonly excludeCallIds?: ReadonlySet<string> },
): Promise<VoiceHistoryResumeResult | null> {
  let store: VoiceHistoryPendingStore;
  try {
    store = await (input.openStore ?? openVoiceHistoryOutbox)();
  } catch {
    // Without storage there is nothing this browser kept.
    return null;
  }
  if (!input.isCurrent()) return null;
  // A resume belongs to the view that started it: it stops when that view or its
  // environment goes away, and the batches stay stored.
  const resolved = await resolveVoiceHistoryOwner(
    input,
    () => input.isCurrent() && input.readPrepared()?.environmentId === input.environmentId,
  );
  if (!resolved) return null;
  if (!resolved.owner || !resolved.historyClient) {
    // Unverifiable ownership keeps everything this browser stored for the environment.
    const retained = (await store.list()).filter(
      (batch) => batch.owner.environmentId === input.environmentId,
    ).length;
    return retained > 0
      ? { sent: 0, retained, errors: [HISTORY_UNVERIFIED_MESSAGE] }
      : { sent: 0, retained: 0, errors: [] };
  }
  return resumeVoiceHistoryOutbox({
    owner: resolved.owner,
    store,
    historyClient: resolved.historyClient,
    excludeCallIds: new Set([...liveVoiceHistoryCalls, ...(input.excludeCallIds ?? [])]),
  });
}
