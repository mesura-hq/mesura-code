import type { Result } from "@symmetria/fm-core/contract";
import { isFailure } from "@symmetria/fm-core/contract";
import { useEffect, useState } from "react";

import { previewDirectoryUrl, previewUrl } from "../../bridge.ts";

/**
 * A URL the browser may load a previewed file from.
 *
 * A same-origin URL under the application's own scheme, NOT a `file://` one and
 * NOT a blob built from bytes sent over the bridge. The renderer has no
 * filesystem by design; the main process authorises each previewed path and
 * hands back an address for it, so nothing here touches the disk and nothing
 * copies a file across the process boundary.
 *
 * Two consumers need it to be exactly this and not a blob: Chromium's document
 * viewer refuses a `blob:` whose origin is a custom scheme — the embed resolves
 * to an error page, invisibly — and a media element streams from a URL rather
 * than holding the whole file in memory.
 *
 * It lives in a module of its own because four components share it now. A hook
 * that stays inside one of its own consumers is the shape that produces a
 * circular import as soon as the second one grows.
 */
export function usePreviewUrl(path: string): string | null {
  return useResolvedUrl(path, previewUrl);
}

/**
 * The URL a previewed file's own DIRECTORY is served under, as a prefix.
 *
 * Append a slash and a relative path to reach a neighbour. What makes it safe
 * to hand a stranger's document is on the other side of the bridge: every such
 * path is checked for containment against the real location on disk, so a
 * symbolic link cannot climb out of the directory.
 *
 * Two rendered previews need it — a markdown file's images and a page's own
 * stylesheet — which is why it sits beside `usePreviewUrl` rather than inside
 * either one.
 */
export function usePreviewDirectoryUrl(path: string): string | null {
  return useResolvedUrl(path, previewDirectoryUrl);
}

/**
 * Ask the main process for a URL, and forget it the moment the path changes.
 *
 * Shared by the two hooks above, which differ only in WHICH question they ask.
 * Written twice first; the second copy is what showed they were one function
 * with a parameter — and a stale URL surviving a cursor move is exactly the
 * bug both copies would have had to avoid independently.
 */
function useResolvedUrl(
  path: string,
  ask: (path: string) => Promise<Result<string>>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setUrl(null);

    void ask(path).then((reply) => {
      if (!current || isFailure(reply)) return;
      setUrl(reply.value);
    });

    return () => {
      current = false;
    };
  }, [path, ask]);

  return url;
}
