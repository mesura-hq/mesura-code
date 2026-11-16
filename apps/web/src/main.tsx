import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";
// This fork's overrides, after upstream's so a tie on specificity goes to ours.
import "./mesura.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
import { installKeyEngine } from "./keys/keyEngine";
import { installNativeFocus } from "./keys/nativeFocus";
import { installPageInputObserver } from "./pushNotifications/pageInput";

// Mesura: the presence report sees every key, so it listens before the key
// engine, which consumes Vim keys (`pushNotifications/pageInput.ts`).
installPageInputObserver();
// Mesura: before any component registers a key listener, so the modal key
// engine runs first in the capture phase. Inert until Vim mode is on.
installKeyEngine();
// Mesura: `Tab` no longer walks the tab order (`keys/nativeFocus.ts`).
installNativeFocus();
import { whenLocaleReady } from "./i18n/runtime";

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
