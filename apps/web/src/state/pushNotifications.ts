import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  followStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Mesura: the host's Web Push RPCs. Every one is guarded by the settings
 * scope, so each is a command; a device names itself by its push endpoint.
 * The presence report at the end is a stream instead.
 */
export const pushPublicKeyCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push:publicKey",
  tag: WS_METHODS.pushPublicKey,
});

export const pushSubscribeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push:subscribe",
  tag: WS_METHODS.pushSubscribe,
});

export const pushUnsubscribeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push:unsubscribe",
  tag: WS_METHODS.pushUnsubscribe,
});

export const pushStatusCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push:status",
  tag: WS_METHODS.pushStatus,
});

export const pushSendTestCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push:sendTest",
  tag: WS_METHODS.pushSendTest,
});

/** Whether this client may use the push RPCs on an environment; they share one scope. */
export const pushSettingsPermissionAtom = (environmentId: EnvironmentId | null) =>
  pushSubscribeCommand.permissionAtom(environmentId);

/**
 * Opens this client's presence report on an environment and returns the
 * function that ends it. The server holds the report while the call is open,
 * and `followStreamInEnvironment` opens it again on a reconnect.
 */
export function openPresenceReport(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  active: boolean,
): () => void {
  const report = connectionAtomRuntime.atom(
    Stream.runDrain(
      followStreamInEnvironment(environmentId, subscribe(WS_METHODS.pushPresence, { active })),
    ).pipe(Effect.ignore),
  );
  return registry.mount(report);
}
