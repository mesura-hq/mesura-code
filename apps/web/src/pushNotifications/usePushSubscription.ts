import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_PUSH_PREFERENCES, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import {
  pushPublicKeyCommand,
  pushSendTestCommand,
  pushSettingsPermissionAtom,
  pushStatusCommand,
  pushSubscribeCommand,
  pushUnsubscribeCommand,
} from "../state/pushNotifications";
import { useAtomCommand } from "../state/use-atom-command";
import {
  currentBrowserSubscription,
  detectPushSupport,
  subscribeBrowser,
  subscriptionInput,
} from "./pushRegistration";

/**
 * What "Push to this device" shows. Only `off` and `on` let the switch move:
 * `forbidden` is a connection without the settings scope the push RPCs need,
 * and `unknown` is a check that failed, which is never reported as off.
 */
export type PushDeviceState =
  | { readonly kind: "checking" }
  | { readonly kind: "unsupported"; readonly reason: "desktop-shell" | "unsupported-browser" }
  | { readonly kind: "blocked" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly endpoint: string };

/** The states known without asking the browser's push service or the host. */
function immediatePushDeviceState(): PushDeviceState {
  const support = detectPushSupport();
  if (support !== "supported") return { kind: "unsupported", reason: support };
  if (Notification.permission === "denied") return { kind: "blocked" };
  return { kind: "checking" };
}

async function successValue<A, E>(result: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const settled = await result;
  if (settled._tag === "Success") return settled.value;
  throw squashAtomCommandFailure(settled);
}

function causeDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs `change` and returns its failure as a status line, or null when it succeeded. */
async function attempt(change: () => Promise<void>): Promise<string | null> {
  try {
    await change();
    return null;
  } catch (cause) {
    return `Push could not be changed: ${causeDetail(cause)}`;
  }
}

/**
 * This device's push subscription on the primary environment, the host whose
 * origin serves the page: a subscription is bound to that host's VAPID key.
 */
export function usePushSubscription() {
  const environmentId = usePrimaryEnvironmentId();
  // A reconnect checks again, so a check that failed while offline does not stick.
  const connectionPhase = usePrimaryEnvironment()?.connection.phase ?? null;
  const canWriteSettings = useAtomValue(pushSettingsPermissionAtom(environmentId));
  const [state, setState] = useState<PushDeviceState>(immediatePushDeviceState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const readPublicKey = useAtomCommand(pushPublicKeyCommand);
  const subscribe = useAtomCommand(pushSubscribeCommand);
  const unsubscribe = useAtomCommand(pushUnsubscribeCommand);
  const readStatus = useAtomCommand(pushStatusCommand);
  const sendTest = useAtomCommand(pushSendTestCommand);

  const readState = async (
    environment: EnvironmentId | null,
    permitted: boolean,
    phase: string | null,
  ): Promise<PushDeviceState> => {
    const immediate = immediatePushDeviceState();
    if (immediate.kind !== "checking") return immediate;
    if (environment !== null && !permitted) return { kind: "forbidden" };
    const subscription = await currentBrowserSubscription();
    if (subscription === null || environment === null) return { kind: "off" };
    // The reconnect runs this check again.
    if (phase !== null && phase !== "connected") {
      return { kind: "unknown", detail: "the host is not connected." };
    }
    const status = await successValue(
      readStatus({ environmentId: environment, input: { endpoint: subscription.endpoint } }),
    );
    return status.subscribed ? { kind: "on", endpoint: subscription.endpoint } : { kind: "off" };
  };

  const check = useEffectEvent(
    (
      environment: EnvironmentId | null,
      permitted: boolean,
      phase: string | null,
      isCurrent: () => boolean,
    ) => {
      readState(environment, permitted, phase).then(
        (next) => {
          if (isCurrent()) setState(next);
        },
        (cause: unknown) => {
          if (isCurrent()) setState({ kind: "unknown", detail: causeDetail(cause) });
        },
      );
    },
  );

  // oxlint-disable-next-line t3code/react-effect-budget -- reads the browser's and host's subscription state whenever the environment, scope or connection changes
  useEffect(() => {
    let current = true;
    check(environmentId, canWriteSettings, connectionPhase, () => current);
    return () => {
      current = false;
    };
  }, [environmentId, canWriteSettings, connectionPhase]);

  const run = async (change: (environment: EnvironmentId) => Promise<void>) => {
    if (environmentId === null || !canWriteSettings || busy) return;
    setBusy(true);
    setMessage(null);
    // React Compiler cannot compile `try … finally` here, so `attempt` holds the try.
    const failure = await attempt(() => change(environmentId));
    setBusy(false);
    if (failure !== null) setMessage(failure);
  };

  const turnOn = () =>
    run(async (environment) => {
      // The permission prompt needs the user's tap, so it comes before any other await.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "blocked" } : { kind: "off" });
        return;
      }
      const { publicKey } = await successValue(
        readPublicKey({ environmentId: environment, input: {} }),
      );
      const subscription = await subscribeBrowser(publicKey);
      await successValue(
        subscribe({
          environmentId: environment,
          input: subscriptionInput(subscription, DEFAULT_PUSH_PREFERENCES),
        }),
      );
      setState({ kind: "on", endpoint: subscription.endpoint });
    });

  const turnOff = () =>
    run(async (environment) => {
      const subscription = await currentBrowserSubscription();
      const endpoint = subscription?.endpoint ?? (state.kind === "on" ? state.endpoint : null);
      if (endpoint !== null) {
        await successValue(unsubscribe({ environmentId: environment, input: { endpoint } }));
      }
      await subscription?.unsubscribe();
      setState({ kind: "off" });
    });

  const sendTestNotification = () =>
    run(async (environment) => {
      if (state.kind !== "on") return;
      const result = await successValue(
        sendTest({ environmentId: environment, input: { endpoint: state.endpoint } }),
      );
      if (result.outcome === "gone") {
        setState({ kind: "off" });
        setMessage("The push service no longer knows this device. Turn push on again.");
        return;
      }
      setMessage("Test notification sent.");
    });

  return {
    state,
    busy,
    message,
    canToggle:
      environmentId !== null &&
      canWriteSettings &&
      !busy &&
      (state.kind === "off" || state.kind === "on"),
    canSendTest: canWriteSettings && !busy && state.kind === "on",
    setEnabled: (enabled: boolean) => (enabled ? turnOn() : turnOff()),
    sendTestNotification,
    checkAgain: () => {
      setState({ kind: "checking" });
      check(environmentId, canWriteSettings, connectionPhase, () => true);
    },
  };
}
