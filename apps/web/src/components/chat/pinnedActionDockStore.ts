import type { PlanId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import {
  dismissPlanFollowUp,
  parsePinnedActionDockUnpins,
  type PinnedActionDockUnpins,
} from "./pinnedActionDock.logic";

interface PinnedActionDockStoreState {
  readonly unpins: PinnedActionDockUnpins;
  readonly dismissFollowUp: (threadKey: string, planId: PlanId) => void;
}

/** Dismissed plan follow-ups persist per browser. */
export const usePinnedActionDockStore = create<PinnedActionDockStoreState>()(
  persist(
    (set) => ({
      unpins: {},
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
