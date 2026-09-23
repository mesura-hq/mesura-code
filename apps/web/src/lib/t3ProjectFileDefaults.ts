import { useEffect, useState } from "react";
import {
  T3_PROJECT_FILE_NAME,
  MESURA_PROJECT_FILE_NAME,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  parseT3ProjectFile,
  parseMesuraProjectFile,
  resolveRepositoryDefaults,
} from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { useEnvironment } from "~/state/environments";

// One checkout read is shared by creation, project retargeting, and the mounted draft.
// A different draft request replaces the entry, so external edits affect new threads.
const checkoutReads = new Map<
  string,
  {
    requestKey: string;
    pending: boolean;
    promise: Promise<ReturnType<typeof resolveRepositoryDefaults>>;
  }
>();
export async function readRepositoryDefaults(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  requestKey?: string,
  refresh = false,
) {
  const presentationAtom = environmentPresentations.presentationAtom(environmentId);
  const connected = () => appAtomRegistry.get(presentationAtom)?.connection.phase === "connected";
  const key = JSON.stringify([environmentId, workspaceRoot]);
  if (!connected()) {
    checkoutReads.delete(key);
    console.warn("Repository defaults deferred while the owning environment is disconnected.");
    return resolveRepositoryDefaults(null, null);
  }
  const cached = checkoutReads.get(key);
  if (requestKey !== undefined && cached?.requestKey === requestKey && (!refresh || cached.pending))
    return cached.promise;
  const controller = new AbortController();
  const unsubscribe = appAtomRegistry.subscribe(presentationAtom, () => {
    if (!connected()) controller.abort();
  });
  const promise = loadRepositoryDefaults(environmentId, workspaceRoot, controller.signal).finally(
    unsubscribe,
  );
  if (requestKey !== undefined) {
    const entry = { requestKey, promise, pending: true };
    checkoutReads.set(key, entry);
    void promise.then(() => {
      entry.pending = false;
      if (controller.signal.aborted && checkoutReads.get(key) === entry) checkoutReads.delete(key);
    });
  }
  return promise;
}

async function loadRepositoryDefaults(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  signal: AbortSignal,
) {
  const read = async (relativePath: string) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, relativePath),
      { refresh: true, signal, reportDefect: false, reportFailure: false },
    );
    const data = resolveProjectFileQueryData(
      environmentId,
      workspaceRoot,
      relativePath,
      result._tag === "Success" ? result.value : null,
    );
    return data && !data.truncated ? data.contents : null;
  };
  const [mesura, legacy] = await Promise.all([
    read(MESURA_PROJECT_FILE_NAME),
    read(T3_PROJECT_FILE_NAME),
  ]);
  return resolveRepositoryDefaults(
    mesura === null ? null : parseMesuraProjectFile(mesura),
    legacy === null ? null : parseT3ProjectFile(legacy),
  );
}

/** Draft-only reader. Identity changes hide stale results while the owning checkout loads. */
export function useRepositoryDefaults(
  environmentId: EnvironmentId,
  cwd: string | null,
  draftId: string | null,
) {
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const key =
    cwd === null || draftId === null
      ? null
      : JSON.stringify([environmentId, cwd, draftId, connected]);
  const [result, setResult] = useState<{
    key: string;
    defaults: Awaited<ReturnType<typeof readRepositoryDefaults>>;
  } | null>(null);
  useEffect(() => {
    if (key === null || cwd === null) return;
    let cancelled = false;
    void readRepositoryDefaults(environmentId, cwd, draftId ?? undefined).then((defaults) => {
      if (!cancelled) setResult({ key, defaults });
    });
    return () => {
      cancelled = true;
    };
  }, [key, environmentId, cwd, draftId]);
  return {
    defaults: key !== null && result?.key === key ? result.defaults : undefined,
    isPending: connected && key !== null && result?.key !== key,
  };
}
