/**
 * Which project the sidebar's thread list is filtered to, or `null` for all of
 * them. The value is a logical project key from `buildSidebarProjectSnapshots`,
 * so it spans every environment a project appears in rather than naming one.
 *
 * This lives in a store rather than in `Sidebar.tsx` because the scope is
 * also changed while the sidebar is not mounted: `projectScope.toggleAll`
 * flips it from anywhere, the phone's closed drawer included.
 *
 * `lastProjectScopeKey` is the last project the filter held, which the toggle
 * returns to. Clearing to every project keeps it.
 *
 * Deliberately NOT persisted. The sidebar opens on every project each session,
 * which is the behaviour the dropdown always had: a filter that survives a
 * reload reads as "my threads disappeared" long before it reads as convenience.
 */
import { create } from "zustand";

interface ProjectScopeStore {
  projectScopeKey: string | null;
  lastProjectScopeKey: string | null;
  setProjectScopeKey: (projectScopeKey: string | null) => void;
  /** Every project from a project, the last project from every project; returns the new scope. */
  toggleAllProjects: () => string | null;
}

export const useProjectScopeStore = create<ProjectScopeStore>()((set, get) => ({
  projectScopeKey: null,
  lastProjectScopeKey: null,
  setProjectScopeKey: (projectScopeKey) =>
    set(
      projectScopeKey === null
        ? { projectScopeKey }
        : { projectScopeKey, lastProjectScopeKey: projectScopeKey },
    ),
  toggleAllProjects: () => {
    const { projectScopeKey, lastProjectScopeKey } = get();
    const next = projectScopeKey === null ? lastProjectScopeKey : null;
    if (next !== projectScopeKey) set({ projectScopeKey: next });
    return next;
  },
}));
