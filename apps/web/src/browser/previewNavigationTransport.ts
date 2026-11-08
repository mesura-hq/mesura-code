import type { DesktopPreviewBridge } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewStateAtom, readThreadPreviewState } from "~/previewStateStore";
import type { ServerBrowserHandle } from "./ServerBrowserSurface";
import type { ThreadLinkTarget, ThreadLinkTransport } from "./threadLinkNavigation";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

type NavigationBridge = Pick<DesktopPreviewBridge, "navigate" | "onStateChange">;

/** The address bar and designated links use this same existing viewer transport.
 * There is deliberately no ordinary-open or metadata-RPC fallback here.
 */
export async function submitPreviewNavigation(
  input: {
    readonly streamed: boolean;
    readonly surface: ServerBrowserHandle | null;
    readonly bridge: Pick<NavigationBridge, "navigate"> | null;
    readonly runtimeTabId: string;
  },
  url: string,
): Promise<boolean> {
  if (input.streamed) return input.surface?.navigate(url) ?? false;
  if (!input.bridge) return false;
  await input.bridge.navigate(input.runtimeTabId, url);
  return true;
}

export function createPreviewNavigationTransport(input: {
  readonly target: ThreadLinkTarget;
  readonly streamed: boolean;
  readonly surface: () => ServerBrowserHandle | null;
  readonly bridge: NavigationBridge | null;
  readonly connectionGeneration?: () => number;
}): ThreadLinkTransport {
  const { target } = input;
  const runtimeTabId = previewRuntimeTabId(target.threadRef, target.serverEpoch, target.tabId);
  return {
    ...(input.connectionGeneration ? { connectionGeneration: input.connectionGeneration } : {}),
    readiness: () => {
      const state = readThreadPreviewState(target.threadRef);
      if (state.serverEpoch !== target.serverEpoch || !state.sessions[target.tabId])
        return "refused";
      if (input.streamed) return input.surface()?.readiness() ?? "waiting";
      // Idle has no panel slot, but the global native host owns its about:blank
      // lease. Wait for that exact WebContents registration, not the slot.
      return input.bridge && state.desktopByTabId[target.tabId]?.hasWebContents
        ? "ready"
        : "waiting";
    },
    navigate: (url) =>
      submitPreviewNavigation(
        {
          streamed: input.streamed,
          surface: input.surface(),
          bridge: input.bridge,
          runtimeTabId,
        },
        url,
      ),
    observe: (listener) => {
      if (!input.streamed && input.bridge) {
        return input.bridge.onStateChange((id, state) => {
          if (id !== runtimeTabId) return;
          if (state.navStatus.kind === "Loading") listener("loading");
          else if (state.navStatus.kind === "LoadFailed") listener("failed");
        });
      }
      let previous = readThreadPreviewState(target.threadRef);
      return appAtomRegistry.subscribe(
        previewStateAtom(scopedThreadKey(target.threadRef)),
        (state) => {
          const before = previous;
          previous = state;
          if (
            state.serverEpoch !== target.serverEpoch ||
            state.serverRevision <= before.serverRevision
          )
            return;
          const snapshot = state.sessions[target.tabId];
          const old = before.sessions[target.tabId];
          if (!snapshot || snapshot.navStatus === old?.navStatus) return;
          // A higher list/viewport revision can repeat an existing Loading value.
          // Require a changed status or target timestamp, not a new object alone.
          if (
            snapshot.navStatus._tag === old?.navStatus._tag &&
            snapshot.updatedAt === old.updatedAt
          )
            return;
          if (snapshot.navStatus._tag === "Loading") listener("loading");
          else if (snapshot.navStatus._tag === "LoadFailed") listener("failed");
        },
      );
    },
  };
}
