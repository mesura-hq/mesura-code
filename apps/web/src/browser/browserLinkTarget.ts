import type { BrowserLinkTarget, ScopedThreadRef } from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { previewEnvironment } from "~/state/preview";

export interface ResolveLinkTargetInput {
  readonly url: string;
  readonly event: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly button?: number | undefined;
  };
  readonly preference: BrowserLinkTarget;
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

export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  // User links stay system-only on phones and touch-first tablets. Manual and
  // agent preview operations use their own entry points and keep their policy.
  if (input.linkClient.viewportWidth < 768 || input.linkClient.primaryPointerCoarse)
    return "system";
  if (input.event.metaKey || input.event.ctrlKey || input.event.button === 1) return "system";
  if (input.preference !== "app") return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  return "app";
}

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Before hydration, the default "system" would ignore a saved "app" link target. */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

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
