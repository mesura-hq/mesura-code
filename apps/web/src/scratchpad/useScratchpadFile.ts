import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { optimisticFileAtom } from "~/components/files/projectFilesQueryState";
import { useServerConfigs } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";

/** The host's scratchpad folder; undefined while the config loads or on a server without it. */
export function useScratchpadRoot(environmentId: EnvironmentId): string | undefined {
  return useServerConfigs().get(environmentId)?.scratchpadRoot;
}

export type ScratchpadFile =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly contents: string }
  | { readonly status: "failed" };

/**
 * One scratchpad file's text for the preview card: the editor's unsaved text first, then what the
 * host has. A file that was never written reads as empty, because the first save creates it.
 * The overlay does not use this cached read: it reads the host afresh on every open.
 */
export function useScratchpadFile(
  environmentId: EnvironmentId,
  root: string,
  relativePath: string,
): { readonly file: ScratchpadFile; readonly refresh: () => void } {
  const atom = projectEnvironment.readFile({
    environmentId,
    input: { cwd: root, relativePath, allowMissing: true },
  });
  const read = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const optimistic = useAtomValue(optimisticFileAtom(environmentId, root, relativePath));
  const file: ScratchpadFile = (() => {
    if (optimistic?.data) return { status: "ready", contents: optimistic.data.contents };
    if (AsyncResult.isFailure(read)) return { status: "failed" };
    const data = AsyncResult.getOrElse(read, () => null);
    if (data === null) return { status: "loading" };
    return { status: "ready", contents: data.exists === false ? "" : data.contents };
  })();
  return { file, refresh };
}
