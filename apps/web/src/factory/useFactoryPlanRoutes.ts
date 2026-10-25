import type { ServerProvider } from "@t3tools/contracts";
import {
  defaultFactoryRoutes,
  readyFactoryRoutes,
  reconcileFactoryRouteSlots,
  validateFactoryRoutes,
  type FactoryRouteSlots,
} from "@t3tools/client-runtime/factory/routes";

import {
  setFactoryPlanEditedRoutes,
  useFactoryPlanEditedRoutes,
  useHoldFactoryPlanCardSession,
} from "./factoryPlanCardSession";

/**
 * The route rows a plan's Approve sends: the defaults until the first edit, then the edits held
 * to the provider lists as they are now, so Approve never sends a model or level the server
 * stopped offering. Shared by every card of the plan (`factoryPlanCardSession.ts`).
 */
export function useFactoryPlanRoutes(planKey: string, providers: ReadonlyArray<ServerProvider>) {
  useHoldFactoryPlanCardSession(planKey);
  const edited = useFactoryPlanEditedRoutes(planKey);
  const slots =
    edited === null
      ? defaultFactoryRoutes(providers)
      : reconcileFactoryRouteSlots(edited, providers);
  const { implementer, reviewer, verifier } = slots;
  const violations =
    implementer.status === "ready" && reviewer.status === "ready" && verifier.status === "ready"
      ? validateFactoryRoutes({
          implementer: implementer.route,
          reviewer: reviewer.route,
          verifier: verifier.route,
        })
      : [];
  const setEdited = (next: FactoryRouteSlots) => setFactoryPlanEditedRoutes(planKey, next);
  return { slots, routes: readyFactoryRoutes(slots), violations, setEdited };
}
