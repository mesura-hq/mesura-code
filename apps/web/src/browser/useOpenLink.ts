import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useThreadLinkOwner } from "./useThreadLinkOwner";
import { openThreadLinkInPreview } from "./openThreadLinkInPreview";
import { BrowserSettingsReadError } from "./openFileInPreview";

const NO_MODIFIER = { metaKey: false, ctrlKey: false } as const;

/**
 * Opens a URL where the "Open links in" setting says, for buttons that sit
 * beside a thread but are not markdown anchors: CI check details, a pull
 * request that has no project to open in the panel. Without a thread there is
 * nowhere to put an in-app tab, so the link goes to the system browser.
 *
 * An in-app open that fails falls back to the system browser rather than
 * dropping the click: the user asked for the link, and the setting only says
 * where it should go first. Failed settings reads reject without opening a
 * browser. The promise also rejects if the system-browser fallback fails.
 */
export function useOpenLink(threadRef: ScopedThreadRef | null | undefined): (
  url: string,
  options?: {
    readonly event?: { readonly metaKey: boolean; readonly ctrlKey: boolean };
    /** Thread to open beside when it is not the hook's own, e.g. a sidebar row's. */
    readonly threadRef?: ScopedThreadRef | undefined;
    readonly explicitApp?: boolean;
    readonly fallbackOnFailure?: boolean;
    readonly reportPreviewFailure?: (cause: Cause.Cause<unknown>) => void;
  },
) => Promise<void> {
  const allocate = useAtomCommand(previewEnvironment.openLinkTarget, { reportFailure: false });
  const captureOwner = useThreadLinkOwner(threadRef);
  return useCallback(
    async (url, options = {}) => {
      const result = await openThreadLinkInPreview({
        threadRef: options.threadRef ?? threadRef,
        url,
        event: options.event ?? NO_MODIFIER,
        ...(options.explicitApp === undefined ? {} : { explicitApp: options.explicitApp }),
        allocate,
        ownerSignal: captureOwner(),
      });
      if (result._tag !== "System") {
        if (isAtomCommandInterrupted(result) || result._tag === "Success") return;
        const failure = squashAtomCommandFailure(result);
        if (failure instanceof BrowserSettingsReadError) throw failure;
        if (options.reportPreviewFailure) options.reportPreviewFailure(result.cause);
        else console.error(result.cause);
        if (options.fallbackOnFailure === false) return;
      }
      const api = readLocalApi();
      if (!api) throw new Error("Link opening is unavailable.");
      await api.shell.openExternal(url);
    },
    [allocate, captureOwner, threadRef],
  );
}
