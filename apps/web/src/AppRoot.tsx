import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { openPushTargets } from "./pushNotifications/notificationTarget";
import { PresenceReporter } from "./pushNotifications/PresenceReporter";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
// Mesura: client zones resolve agent snoozes on every host.
import { ClientTimeZoneReporter } from "./state/reportClientTimeZone";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  // Mesura: a tapped push notification opens its thread, or its agent search, in this window.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to service-worker notification clicks for the app's lifetime
  useEffect(() => openPushTargets(router), [router]);
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      {/* Mesura: while the developer is at this client, the host holds phone pushes. */}
      <PresenceReporter />
      {/* Mesura: report the current device zone for agent snoozes. */}
      <ClientTimeZoneReporter />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
