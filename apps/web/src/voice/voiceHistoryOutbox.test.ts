import {
  BearerConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type {
  VoiceHistoryClient,
  VoiceHistoryPendingBatch,
  VoiceHistoryPendingStore,
} from "@t3tools/client-runtime/voice-conversation/history";
import { EnvironmentId, ThreadId, type VoiceConversationSettings } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  claimVoiceHistoryCall,
  openVoiceHistoryOutbox,
  prepareVoiceHistory,
  resumePendingVoiceHistory,
  voiceHistoryOwnerFor,
  type VoiceHistoryClientOwner,
  type VoiceHistoryEnvironment,
} from "./voiceHistoryOutbox";

// The identity rules (renewal, subject, proof key, cookie session) are pinned where they are
// decided: the authenticated settings response in apps/server/src/voice/http.test.ts. Reload
// durability and the additive IndexedDB upgrade need a real browser database; Node has none,
// so they are proved by the headless probe recorded in the phase evidence.

afterEach(() => {
  vi.unstubAllGlobals();
});

const environmentOne = EnvironmentId.make("environment-1");
const environmentTwo = EnvironmentId.make("environment-2");

const settings = (historyOwnerId?: string): VoiceConversationSettings => ({
  configured: true,
  canConfigure: false,
  model: "gpt-live-1",
  maxDurationSeconds: 900,
  ...(historyOwnerId ? { historyOwnerId } : {}),
});

const connection = (environmentId: EnvironmentId, token: string): PreparedConnection => ({
  environmentId,
  label: "laptop",
  httpBaseUrl: "https://laptop.example.test",
  socketUrl: "wss://laptop.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token },
  target: new BearerConnectionTarget({ environmentId, label: "laptop", connectionId: "c-1" }),
});

const pendingBatch = (clientIdentity: string): VoiceHistoryPendingBatch => ({
  owner: { environmentId: environmentOne, clientIdentity },
  threadId: "thread-1",
  callId: "call-aaaaaaaaaaaaaaaa",
  batchId: `batch-${clientIdentity}`,
  fragments: [{ fragmentId: "f-1", sequence: 1, speaker: "user", text: "Texto guardado." }],
});

const makeStore = (batches: ReadonlyArray<VoiceHistoryPendingBatch>) => {
  const backing = new Map(batches.map((batch) => [batch.batchId, batch]));
  const store: VoiceHistoryPendingStore = {
    list: async () => [...backing.values()],
    put: async (batch) => {
      backing.set(batch.batchId, batch);
    },
    remove: async (batch) => {
      backing.delete(batch.batchId);
    },
  };
  return { store, backing };
};

const makeEnvironment = (reported: () => VoiceConversationSettings) => {
  const append = vi.fn<VoiceHistoryClient["append"]>(async () => ({ lastSequence: 1 }));
  const end = vi.fn<VoiceHistoryClient["end"]>(async () => undefined);
  const readCall = vi.fn<VoiceHistoryClient["readCall"]>(async ({ threadId, callId }) => ({
    callId,
    threadId: ThreadId.make(threadId),
    startedAt: "2026-11-08T10:00:00.000Z",
    endedAt: null,
    endReason: null,
    finalSequence: null,
    lastSequence: 0,
    ownedByRequester: true,
  }));
  const settingsFor = vi.fn(async (_prepared: PreparedConnection) => reported());
  const clientOwners: VoiceHistoryClientOwner[] = [];
  const environment: VoiceHistoryEnvironment = {
    settings: settingsFor,
    makeHistoryClient: (_prepared, owner) => {
      clientOwners.push(owner);
      return { append, end, readCall };
    },
  };
  return { environment, append, end, readCall, settingsFor, clientOwners };
};

describe("voice history outbox owner", () => {
  it("voice history owner is the environment plus its authenticated history owner", () => {
    const before = voiceHistoryOwnerFor({
      environmentId: environmentOne,
      settings: settings("owner-digest-a"),
    });
    // A renewed credential of the same verified owner reports the same opaque owner.
    const renewed = voiceHistoryOwnerFor({
      environmentId: environmentOne,
      settings: settings("owner-digest-a"),
    });

    expect(before).toEqual({ environmentId: environmentOne, clientIdentity: "owner-digest-a" });
    expect(renewed).toEqual(before);
  });

  it("voice history owner differs for another environment or another reported owner", () => {
    const original = voiceHistoryOwnerFor({
      environmentId: environmentOne,
      settings: settings("owner-digest-a"),
    });

    expect(
      voiceHistoryOwnerFor({ environmentId: environmentTwo, settings: settings("owner-digest-a") }),
    ).not.toEqual(original);
    expect(
      voiceHistoryOwnerFor({ environmentId: environmentOne, settings: settings("owner-digest-b") }),
    ).not.toEqual(original);
  });

  it("voice history owner is absent when the environment reports no history owner", () => {
    expect(
      voiceHistoryOwnerFor({ environmentId: environmentOne, settings: settings() }),
    ).toBeNull();
    expect(voiceHistoryOwnerFor({ environmentId: environmentOne, settings: null })).toBeNull();
  });
});

describe("voice history outbox resume", () => {
  it("voice history resume sends a kept batch once the environment reports the same owner", async () => {
    const { store, backing } = makeStore([pendingBatch("owner-digest-a")]);
    const environment = makeEnvironment(() => settings("owner-digest-a"));

    const result = await resumePendingVoiceHistory({
      environmentId: environmentOne,
      readPrepared: () => connection(environmentOne, "token-renewed"),
      isCurrent: () => true,
      openStore: async () => store,
      environment: environment.environment,
    });

    expect(environment.append).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ sent: 1, retained: 0 });
    expect(backing.size).toBe(0);
  });

  it("voice history resume sends no transcript when the environment reports another owner", async () => {
    const { store, backing } = makeStore([pendingBatch("owner-digest-a")]);
    const environment = makeEnvironment(() => settings("owner-digest-b"));

    await resumePendingVoiceHistory({
      environmentId: environmentOne,
      readPrepared: () => connection(environmentOne, "other-session"),
      isCurrent: () => true,
      openStore: async () => store,
      environment: environment.environment,
    });

    expect(environment.append).not.toHaveBeenCalled();
    expect(environment.end).not.toHaveBeenCalled();
    expect(backing.size).toBe(1);
  });

  it("voice history resume keeps the batch and explains when the environment proves no owner", async () => {
    const { store, backing } = makeStore([pendingBatch("owner-digest-a")]);
    const environment = makeEnvironment(() => settings());

    const result = await resumePendingVoiceHistory({
      environmentId: environmentOne,
      readPrepared: () => connection(environmentOne, "token"),
      isCurrent: () => true,
      openStore: async () => store,
      environment: environment.environment,
    });

    expect(environment.append).not.toHaveBeenCalled();
    expect(environment.readCall).not.toHaveBeenCalled();
    expect(backing.size).toBe(1);
    expect(result?.errors).toEqual([expect.stringMatching(/history/i)]);
  });

  it("voice history resume sends nothing after the host moves to another environment", async () => {
    const { store, backing } = makeStore([pendingBatch("owner-digest-a")]);
    const environment = makeEnvironment(() => settings("owner-digest-a"));
    let selected = environmentOne;
    environment.settingsFor.mockImplementation(async () => {
      selected = environmentTwo;
      return settings("owner-digest-a");
    });

    const result = await resumePendingVoiceHistory({
      environmentId: environmentOne,
      readPrepared: () => connection(selected, "token"),
      isCurrent: () => selected === environmentOne,
      openStore: async () => store,
      environment: environment.environment,
    });

    expect(result).toBeNull();
    expect(environment.append).not.toHaveBeenCalled();
    expect(backing.size).toBe(1);
  });
});

describe("voice history outbox storage", () => {
  it("voice history outbox refuses to open without IndexedDB and says history cannot be saved", async () => {
    vi.stubGlobal("indexedDB", undefined);

    await expect(openVoiceHistoryOutbox()).rejects.toThrow(/history/i);
  });

  it("voice history preparation explains unsupported history before the microphone", async () => {
    const environment = makeEnvironment(() => settings());

    await expect(
      prepareVoiceHistory({
        environmentId: environmentOne,
        readPrepared: () => connection(environmentOne, "token"),
        isCurrent: () => true,
        openStore: async () => makeStore([]).store,
        environment: environment.environment,
      }),
    ).rejects.toThrow(/cannot save voice history/i);
  });

  it("voice history call client keeps sending after its view closes while the owner is verified", async () => {
    const environment = makeEnvironment(() => settings("owner-digest-a"));
    let viewOpen = true;

    const prepared = await prepareVoiceHistory({
      environmentId: environmentOne,
      readPrepared: () => connection(environmentOne, "token"),
      isCurrent: () => viewOpen,
      openStore: async () => makeStore([]).store,
      environment: environment.environment,
    });
    viewOpen = false;

    // Every request of this client still proves this owner; the view no longer limits it.
    expect(environment.clientOwners).toHaveLength(1);
    expect(environment.clientOwners[0]!.historyOwnerId).toBe("owner-digest-a");
    expect(environment.clientOwners[0]!.isCurrent()).toBe(true);
    expect(prepared.owner.clientIdentity).toBe("owner-digest-a");
  });

  it("voice history resume client stops sending when its view closes", async () => {
    const environment = makeEnvironment(() => settings("owner-digest-a"));
    let viewOpen = true;
    const { store } = makeStore([pendingBatch("owner-digest-a")]);
    environment.append.mockImplementation(async () => {
      viewOpen = false;
      return { lastSequence: 1 };
    });

    await resumePendingVoiceHistory({
      environmentId: environmentOne,
      readPrepared: () => connection(environmentOne, "token"),
      isCurrent: () => viewOpen,
      openStore: async () => store,
      environment: environment.environment,
    });

    expect(environment.clientOwners[0]!.historyOwnerId).toBe("owner-digest-a");
    expect(environment.clientOwners[0]!.isCurrent()).toBe(false);
  });

  it("voice history resume leaves a call alone while its recorder still owns it", async () => {
    const { store, backing } = makeStore([pendingBatch("owner-digest-a")]);
    const environment = makeEnvironment(() => settings("owner-digest-a"));
    const resume = () =>
      resumePendingVoiceHistory({
        environmentId: environmentOne,
        readPrepared: () => connection(environmentOne, "token"),
        isCurrent: () => true,
        openStore: async () => store,
        environment: environment.environment,
      });
    // A call whose panel unmounted keeps sending its own batches until it ends.
    const release = claimVoiceHistoryCall("call-aaaaaaaaaaaaaaaa");

    await resume();
    expect(environment.readCall).not.toHaveBeenCalled();
    expect(environment.append).not.toHaveBeenCalled();
    expect(backing.size).toBe(1);

    release();
    await resume();
    expect(environment.append).toHaveBeenCalledOnce();
    expect(backing.size).toBe(0);
  });
});
