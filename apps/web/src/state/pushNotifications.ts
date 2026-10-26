import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Mesura: the host's Web Push RPCs. Every one is guarded by the settings
 * scope, so each is a command; a device names itself by its push endpoint.
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
