import type { SymmetriaDictationSession } from "@symmetria/broker-contract";
import { create } from "zustand";

type DictationSessionStoreState = {
  readonly session: SymmetriaDictationSession | null;
  readonly setSession: (session: SymmetriaDictationSession | null) => void;
};

export const useDictationSessionStore = create<DictationSessionStoreState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
}));
