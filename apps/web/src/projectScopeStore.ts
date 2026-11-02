/**
 * A store, not `Sidebar.tsx` state, because `projectScope.toggleAll` changes the scope while
 * the sidebar is unmounted. Each key is a logical project key spanning every environment; an
 * empty list is every project. Deliberately NOT persisted: a filter that survives a reload
 * reads as lost threads. Upstream persists its copy in `uiStateStore`; this one replaces it.
 */
import { create } from "zustand";

const EVERY_PROJECT: readonly string[] = [];

interface ProjectScopeStore {
  projectScopeKeys: readonly string[];
  lastProjectScopeKeys: readonly string[];
  setProjectScopeKeys: (projectScopeKeys: readonly string[]) => void;
  /** Every project from a scope, the last scope from every project; returns the new scope. */
  toggleAllProjects: () => readonly string[];
}

export const useProjectScopeStore = create<ProjectScopeStore>()((set, get) => ({
  projectScopeKeys: EVERY_PROJECT,
  lastProjectScopeKeys: EVERY_PROJECT,
  setProjectScopeKeys: (projectScopeKeys) =>
    set(
      projectScopeKeys.length === 0
        ? { projectScopeKeys: EVERY_PROJECT }
        : { projectScopeKeys, lastProjectScopeKeys: projectScopeKeys },
    ),
  toggleAllProjects: () => {
    const { projectScopeKeys, lastProjectScopeKeys } = get();
    const next = projectScopeKeys.length === 0 ? lastProjectScopeKeys : EVERY_PROJECT;
    if (next !== projectScopeKeys) set({ projectScopeKeys: next });
    return next;
  },
}));
