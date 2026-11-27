import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { AuthSessionState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { availabilityOf } from "./armedThreadAvailability";

const synchronizing: EnvironmentThreadState = {
  ...EMPTY_ENVIRONMENT_THREAD_STATE,
  status: "synchronizing",
};
const readingSession = AsyncResult.success<AuthSessionState>({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "armed-thread",
  },
  permissions: ["orchestration:read", "orchestration:operate"],
});
const pendingSession = AsyncResult.initial<AuthSessionState>();

function connection(
  patch: Partial<SupervisorConnectionState>,
): AsyncResult.AsyncResult<SupervisorConnectionState, unknown> {
  return AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, ...patch });
}

describe("armed thread availability while the detail loads", () => {
  it("is unreadable once a reconnect is blocked on a refused credential, before any session lookup", () => {
    const refused = connection({
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({
        reason: "authentication",
        detail: "The host rejected this device's credential.",
      }),
    });
    expect(availabilityOf(synchronizing, pendingSession, refused, "data")).toBe("unreadable");
  });

  it("keeps waiting through a transient failure or a block for another reason", () => {
    const transient = connection({
      phase: "backoff",
      lastFailure: new ConnectionTransientError({ reason: "network", detail: "offline" }),
    });
    const unsupported = connection({
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({ reason: "unsupported", detail: "old server" }),
    });
    expect(availabilityOf(synchronizing, readingSession, transient, "data")).toBe("loading");
    expect(availabilityOf(synchronizing, readingSession, unsupported, "data")).toBe("loading");
  });

  it("does not judge a thread whose detail already arrived", () => {
    const refused = connection({
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({ reason: "permission", detail: "no read" }),
    });
    const loaded: EnvironmentThreadState = { ...synchronizing, status: "live" };
    expect(availabilityOf(loaded, pendingSession, refused, "live")).toBe("loaded");
  });
});
