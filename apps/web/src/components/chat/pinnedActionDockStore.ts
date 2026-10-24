import type { PlanId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import {
  dismissPlanFollowUp,
  parsePinnedActionDockUnpins,
  unpinFactoryPlan,
  type PinnedActionDockUnpins,
} from "./pinnedActionDock.logic";

interface PinnedActionDockStoreState {
  readonly unpins: PinnedActionDockUnpins;
  readonly unpinPlan: (threadKey: string, digest: string) => void;
  readonly dismissFollowUp: (threadKey: string, planId: PlanId) => void;
}

/** Mesura: the dock's unpinned plans and dismissed follow-ups, kept across reloads per browser. */
export const usePinnedActionDockStore = create<PinnedActionDockStoreState>()(
  persist(
    (set) => ({
      unpins: {},
      unpinPlan: (threadKey, digest) =>
        set((state) => ({ unpins: unpinFactoryPlan(state.unpins, threadKey, digest) })),
      dismissFollowUp: (threadKey, planId) =>
        set((state) => ({ unpins: dismissPlanFollowUp(state.unpins, threadKey, planId) })),
    }),
    {
      name: "mesura:pinned-action-dock:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: ({ unpins }) => ({ unpins }),
      merge: (persisted, current) => ({
        ...current,
        unpins: parsePinnedActionDockUnpins((persisted as { unpins?: unknown } | null)?.unpins),
      }),
    },
  ),
);
