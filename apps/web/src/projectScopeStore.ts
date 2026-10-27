/**
 * A store, not `Sidebar.tsx` state, because `projectScope.toggleAll` changes the scope while
 * the sidebar is unmounted. The key is a logical project key spanning every environment.
 * Deliberately NOT persisted: a filter that survives a reload reads as lost threads.
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
