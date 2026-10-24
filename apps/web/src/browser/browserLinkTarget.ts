/**
 * Where a link clicked inside a thread should open.
 *
 * Settings → Integrations → Browser lets the user choose between the OS
 * default browser and a tab in the in-app browser. This module turns that
 * preference plus the click itself into one answer, so chat markdown and the
 * terminal drawer make the same decision and offer the same escape hatch.
 *
 * @module browserLinkTarget
 */
import type { BrowserLinkTarget, ScopedThreadRef } from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { previewEnvironment } from "~/state/preview";

export interface ResolveLinkTargetInput {
  readonly url: string;
  /** Cmd/Ctrl-click always goes to the system browser, whatever the default. */
  readonly event: { readonly metaKey: boolean; readonly ctrlKey: boolean };
  readonly preference: BrowserLinkTarget;
  /** Whether this client has an in-app browser and a thread to open it beside. */
  readonly canOpenInApp: boolean;
  readonly linkClient: LinkClient;
}

export interface LinkClient {
  readonly viewportWidth: number;
  readonly primaryPointerCoarse: boolean;
}

/** Read at activation, not render: a pending menu can outlive a viewport change. */
export function readLinkClient(): LinkClient {
  return {
    viewportWidth: typeof window === "undefined" ? Infinity : window.innerWidth,
    primaryPointerCoarse:
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
  };
}

/**
 * The target a click resolves to. "app" only comes back when the preference
 * asks for it, the runtime can honour it, the URL is one the in-app browser
 * can load, and the click carried no modifier — the modifier is the one-gesture
 * way out when the default is in-app, mirroring how change-request links
 * already treat it.
 */
export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  // User links stay system-only on phones and touch-first tablets. Manual and
  // agent preview operations use their own entry points and keep their policy.
  if (input.linkClient.viewportWidth < 768 || input.linkClient.primaryPointerCoarse)
    return "system";
  if (input.event.metaKey || input.event.ctrlKey) return "system";
  if (input.preference !== "app") return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  return "app";
}

/**
 * Only http(s) can load in the in-app browser. Anything else — mailto:,
 * vscode://, a bare fragment — belongs to the shell whatever the preference.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The configured default, once client settings have actually loaded. Before
 * hydration the snapshot is the schema default ("system"), so a link clicked
 * in the first moments after launch would ignore a persisted "app" — opening
 * is asynchronous anyway, so waiting costs nothing the user can see.
 * Read failures reject rather than choosing a browser without the saved preference.
 */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

/** Whether this thread's environment has an in-app browser available to this client. */
export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  if (!threadRef || threadRef.threadId.length === 0) return false;
  const capabilities = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(threadRef.environmentId)?.environment.capabilities;
  return (
    capabilities?.serverBrowser === true &&
    capabilities.threadLinkPreview === true &&
    appAtomRegistry.get(previewEnvironment.openLinkTarget.permissionAtom(threadRef.environmentId))
  );
}
