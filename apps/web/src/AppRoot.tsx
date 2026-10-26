import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { openPushTargets } from "./pushNotifications/notificationTarget";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * The Electron browser host intentionally sits outside the router so its
 * webviews survive route transitions, but it must share the same atom registry
 * as routed UI.
 */
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
  useEffect(() => openPushTargets(router), [router]);
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <BrowserProfileReporter />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
