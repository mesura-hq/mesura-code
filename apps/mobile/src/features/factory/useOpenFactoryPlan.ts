import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

/**
 * A plan card's Open: pushes the thread's Factory screen above the feed, so
 * Back returns to the feed where it was.
 */
export function useOpenFactoryPlan(environmentId: EnvironmentId, threadId: ThreadId) {
  const navigation = useNavigation();
  return useCallback(
    (planId: string) => {
      navigation.navigate("ThreadFactory", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        planId,
      });
    },
    [navigation, environmentId, threadId],
  );
}
