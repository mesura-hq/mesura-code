import { useAtomValue } from "@effect/atom-react";
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
 * One scratchpad file's text: the editor's unsaved text first, then what the host has. A file that
 * was never written reads as empty, because the first save creates it. A failed read is never
 * empty: an editor opened on it would save over the notes it could not read.
 */
export function useScratchpadFile(
  environmentId: EnvironmentId,
  root: string,
  relativePath: string,
): ScratchpadFile {
  const read = useAtomValue(
    projectEnvironment.readFile({
      environmentId,
      input: { cwd: root, relativePath, allowMissing: true },
    }),
  );
  const optimistic = useAtomValue(optimisticFileAtom(environmentId, root, relativePath));
  if (optimistic?.data) return { status: "ready", contents: optimistic.data.contents };
  if (AsyncResult.isFailure(read)) return { status: "failed" };
  const data = AsyncResult.getOrElse(read, () => null);
  if (data === null) return { status: "loading" };
  return { status: "ready", contents: data.exists === false ? "" : data.contents };
}
