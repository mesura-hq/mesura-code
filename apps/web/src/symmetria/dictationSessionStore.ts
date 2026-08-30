import type { SymmetriaDictationSession } from "@symmetria/broker-contract";
import { create } from "zustand";

type DictationSessionStoreState = {
  readonly session: SymmetriaDictationSession | null;
  readonly bridgeAvailable: boolean;
  readonly error: string | null;
  readonly setSession: (session: SymmetriaDictationSession | null) => void;
  readonly setBridgeAvailable: (available: boolean) => void;
  readonly setError: (error: string | null) => void;
};

export const useDictationSessionStore = create<DictationSessionStoreState>((set) => ({
  session: null,
  bridgeAvailable: false,
  error: null,
  setSession: (session) => set({ session }),
  setBridgeAvailable: (bridgeAvailable) => set({ bridgeAvailable }),
  setError: (error) => set({ error }),
}));
