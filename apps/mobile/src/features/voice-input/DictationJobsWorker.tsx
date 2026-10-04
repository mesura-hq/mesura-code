import { hostHasDictationKey } from "@t3tools/client-runtime/dictation";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { watchDictationJobs } from "../../state/dictation";
import { useServerConfigs } from "../../state/entities";

function EnvironmentDictationJobs(props: { readonly environmentId: EnvironmentId }) {
  useEffect(() => watchDictationJobs(props.environmentId), [props.environmentId]);
  return null;
}

/**
 * Watches the dictation jobs of every connected host that can transcribe, once per host, for as
 * long as the app runs. Mounted at the root, beside the outbox drain, so a transcript fills its
 * draft and an armed draft sends whichever screen is open.
 */
export function DictationJobsWorker() {
  const configs = useServerConfigs();
  const environmentIds = useMemo(
    () =>
      [...configs]
        .filter(([, config]) => hostHasDictationKey(config))
        .map(([environmentId]) => environmentId),
    [configs],
  );
  return environmentIds.map((environmentId) => (
    <EnvironmentDictationJobs key={environmentId} environmentId={environmentId} />
  ));
}
