/**
 * Which project the sidebar's thread list is filtered to, or `null` for all of
 * them. The value is a logical project key from `buildSidebarProjectSnapshots`,
 * so it spans every environment a project appears in rather than naming one.
 *
 * This lives in a store rather than in `Sidebar.tsx` because two surfaces write
 * it: the project menu above the thread list, and the project scope picker the
 * command palette opens. A filter the picker could not read would be a second
 * filter, and the two would drift.
 *
 * Deliberately NOT persisted. The sidebar opens on every project each session,
 * which is the behaviour the dropdown always had: a filter that survives a
 * reload reads as "my threads disappeared" long before it reads as convenience.
 */
import { create } from "zustand";

interface ProjectScopeStore {
  projectScopeKey: string | null;
  setProjectScopeKey: (projectScopeKey: string | null) => void;
}

export const useProjectScopeStore = create<ProjectScopeStore>()((set) => ({
  projectScopeKey: null,
  setProjectScopeKey: (projectScopeKey) => set({ projectScopeKey }),
}));
