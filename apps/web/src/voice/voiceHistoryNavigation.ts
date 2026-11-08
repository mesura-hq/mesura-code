import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { useRouter } from "@tanstack/react-router";
import { create } from "zustand";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";

type Router = ReturnType<typeof useRouter>;

/**
 * Navigation for voice conversations, kept in one place for every entry point: the thread menu in
 * the header and in the sidebar, and the composer phone when the environment has no key.
 *
 * Opening saved history only reads: it never starts audio, sends a request or changes a turn.
 * The settings detour remembers the thread so the user can return to it, and returning never
 * starts the microphone.
 */
interface VoiceNavigationState {
  /** The thread whose saved voice conversations are open, by scoped key. */
  readonly historyThreadKey: string | null;
  /** The thread to return to from voice settings. */
  readonly settingsReturn: ScopedThreadRef | null;
}

const useVoiceNavigationStore = create<VoiceNavigationState>(() => ({
  historyThreadKey: null,
  settingsReturn: null,
}));

/** Environments from before saved voice history never get the entry or its requests. */
export function readEnvironmentSupportsVoiceHistory(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .voiceHistory === true
  );
}

export function useEnvironmentSupportsVoiceHistory(environmentId: EnvironmentId): boolean {
  return (
    useAtomValue(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .voiceHistory === true
  );
}

export function openVoiceHistory(router: Router, threadRef: ScopedThreadRef): void {
  useVoiceNavigationStore.setState({ historyThreadKey: scopedThreadKey(threadRef) });
  void router.navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(threadRef),
  });
}

export function closeVoiceHistory(): void {
  useVoiceNavigationStore.setState({ historyThreadKey: null });
}

export function useVoiceHistoryOpen(threadRef: ScopedThreadRef | null): boolean {
  const key = threadRef ? scopedThreadKey(threadRef) : null;
  return useVoiceNavigationStore((state) => key !== null && state.historyThreadKey === key);
}

/** Opens the environment's voice settings and remembers the thread to come back to. */
export function openVoiceSettings(router: Router, returnTo: ScopedThreadRef): void {
  useVoiceNavigationStore.setState({ settingsReturn: returnTo });
  void router.navigate({
    to: "/settings/integrations",
    search: { machine: returnTo.environmentId },
    hash: "voice",
  });
}

export function useVoiceSettingsReturn(): ScopedThreadRef | null {
  return useVoiceNavigationStore((state) => state.settingsReturn);
}

/** Returns to the thread that opened voice settings. The call is not started again. */
export function returnFromVoiceSettings(router: Router): void {
  const returnTo = useVoiceNavigationStore.getState().settingsReturn;
  useVoiceNavigationStore.setState({ settingsReturn: null });
  if (returnTo)
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(returnTo),
    });
}
