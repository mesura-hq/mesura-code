/**
 * Scope remains unpersisted so a reload cannot hide threads. Upstream's multiple-project
 * selection and Mesura's toggle-all command share the same selection and recall state.
 */
import { create } from "zustand";

interface ProjectScopeStore {
  projectScopeKeys: readonly string[];
  lastProjectScopeKeys: readonly string[];
  /** Scalar compatibility for commands that report the current scope. */
  projectScopeKey: string | null;
  lastProjectScopeKey: string | null;
  setProjectScopeKeys: (keys: readonly string[]) => void;
  setProjectScopeKey: (key: string | null) => void;
  toggleAllProjects: () => string | null;
}

const scopeKey = (keys: readonly string[]) => (keys.length === 0 ? null : keys.join("\n"));

export const useProjectScopeStore = create<ProjectScopeStore>()((set, get) => {
  const setProjectScopeKeys = (keys: readonly string[]) => {
    const projectScopeKeys = [...new Set(keys)];
    set({
      projectScopeKeys,
      projectScopeKey: scopeKey(projectScopeKeys),
      ...(projectScopeKeys.length === 0
        ? {}
        : {
            lastProjectScopeKeys: projectScopeKeys,
            lastProjectScopeKey: scopeKey(projectScopeKeys),
          }),
    });
  };
  return {
    projectScopeKeys: [],
    lastProjectScopeKeys: [],
    projectScopeKey: null,
    lastProjectScopeKey: null,
    setProjectScopeKeys,
    setProjectScopeKey: (key) => setProjectScopeKeys(key === null ? [] : [key]),
    toggleAllProjects: () => {
      const state = get();
      setProjectScopeKeys(state.projectScopeKeys.length === 0 ? state.lastProjectScopeKeys : []);
      return get().projectScopeKey;
    },
  };
});
