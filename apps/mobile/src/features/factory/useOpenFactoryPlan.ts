import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

/**
 * A Factory card's Open: pushes the thread's Factory screen above the feed, so
 * Back returns to the feed where it was. A plan card opens its plan; a run
 * card opens the Run tab on its run.
 */
function useOpenFactoryScreen(environmentId: EnvironmentId, threadId: ThreadId) {
  const navigation = useNavigation();
  return useCallback(
    (target: { readonly planId: string } | { readonly tab: "run"; readonly runId: string }) => {
      navigation.navigate("ThreadFactory", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        ...target,
      });
    },
    [navigation, environmentId, threadId],
  );
}

export function useOpenFactoryPlan(environmentId: EnvironmentId, threadId: ThreadId) {
  const open = useOpenFactoryScreen(environmentId, threadId);
  return useCallback((planId: string) => open({ planId }), [open]);
}

export function useOpenFactoryRun(environmentId: EnvironmentId, threadId: ThreadId) {
  const open = useOpenFactoryScreen(environmentId, threadId);
  return useCallback((runId: string) => open({ tab: "run", runId }), [open]);
}
