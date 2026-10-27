import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { openPushTargets } from "./pushNotifications/notificationTarget";
import { PresenceReporter } from "./pushNotifications/PresenceReporter";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );
  // Mesura: a tapped push notification opens its thread, or its agent search, in this window.
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to service-worker notification clicks for the app's lifetime
  useEffect(() => openPushTargets(router), [router]);
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      {/* Mesura: while the developer is at this client, the host holds phone pushes. */}
      <PresenceReporter />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
