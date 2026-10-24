import type { FactoryRouteSlots } from "@t3tools/client-runtime/factory/routes";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * Mesura: what the timeline's plan card and the composer dock's pinned plan share for one plan's
 * bytes in one thread: the edited route rows, and whether an approval of them is being sent. Two
 * controls approve the same plan, so they read one state: both send the same routes and both
 * disable while either sends.
 *
 * A session lasts while something holds it: a card of the plan, or the dock entry that pins it,
 * collapsed or not. So an edit survives the timeline card leaving the virtualized list and the
 * dock body collapsing at phone width, and resets once nothing shows the plan, as a card's own
 * state did.
 */
interface FactoryPlanCardSession {
  readonly routes?: FactoryRouteSlots;
  readonly sending?: boolean;
}

const useFactoryPlanCardSessions = create<{
  readonly byPlan: Readonly<Record<string, FactoryPlanCardSession>>;
}>(() => ({ byPlan: {} }));
const holdersByPlan = new Map<string, number>();

function updateSession(planKey: string, change: FactoryPlanCardSession) {
  useFactoryPlanCardSessions.setState((state) => ({
    byPlan: { ...state.byPlan, [planKey]: { ...state.byPlan[planKey], ...change } },
  }));
}

/** Keeps one plan's session alive while the caller is mounted; `null` holds nothing. */
export function useHoldFactoryPlanCardSession(planKey: string | null) {
  useEffect(() => {
    if (planKey === null) return;
    holdersByPlan.set(planKey, (holdersByPlan.get(planKey) ?? 0) + 1);
    return () => {
      const remaining = (holdersByPlan.get(planKey) ?? 1) - 1;
      if (remaining > 0) {
        holdersByPlan.set(planKey, remaining);
        return;
      }
      holdersByPlan.delete(planKey);
      useFactoryPlanCardSessions.setState((state) => {
        if (!(planKey in state.byPlan)) return state;
        const { [planKey]: _dropped, ...byPlan } = state.byPlan;
        return { byPlan };
      });
    };
  }, [planKey]);
}

export function useFactoryPlanEditedRoutes(planKey: string): FactoryRouteSlots | null {
  return useFactoryPlanCardSessions((state) => state.byPlan[planKey]?.routes ?? null);
}

export function setFactoryPlanEditedRoutes(planKey: string, routes: FactoryRouteSlots) {
  updateSession(planKey, { routes });
}

export function useFactoryPlanSending(planKey: string): boolean {
  return useFactoryPlanCardSessions((state) => state.byPlan[planKey]?.sending === true);
}

/** Marks the plan's approval as sending; false when another control already sends it. */
export function beginFactoryPlanSend(planKey: string): boolean {
  if (useFactoryPlanCardSessions.getState().byPlan[planKey]?.sending === true) return false;
  updateSession(planKey, { sending: true });
  return true;
}

/** A send that failed: Approve is enabled again on every control. */
export function failFactoryPlanSend(planKey: string) {
  updateSession(planKey, { sending: false });
}
