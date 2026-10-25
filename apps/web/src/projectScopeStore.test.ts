import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useProjectScopeStore } from "./projectScopeStore";

beforeEach(() => {
  // Replace, not merge: the toggle's memory of the last project must not leak between tests.
  useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
});

describe("projectScopeStore", () => {
  it("starts on every project, so a filter can never hide threads at boot", () => {
    // Read the module's own initial state rather than what beforeEach just
    // wrote, or the assertion proves nothing about a fresh session.
    //
    // This does NOT prove the scope is unpersisted. That property lives in the
    // store's construction — it is built without zustand's persist middleware —
    // and this suite runs with no localStorage, so nothing here could observe a
    // rehydration either way. An earlier version of this file asserted the
    // absence of the middleware's `persist` key and claimed that as proof; it
    // was testing zustand's API surface, not our behaviour.
    expect(useProjectScopeStore.getInitialState().projectScopeKey).toBe(null);
  });

  it("scopes the thread list to one project", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");

    expect(useProjectScopeStore.getState().projectScopeKey).toBe("env-1:project-a");
  });

  it("replaces the scope rather than accumulating scopes", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-b");

    expect(useProjectScopeStore.getState().projectScopeKey).toBe("env-1:project-b");
  });

  it("keeps the setter's identity stable across scope changes", () => {
    // Sidebar.tsx selects the value and the setter separately. That is only
    // cheap while the setter's reference survives a state change; an action
    // rebuilt on every set would re-render the sidebar on every filter change
    // for no reason, and nothing else would notice.
    const setProjectScopeKey = useProjectScopeStore.getState().setProjectScopeKey;

    setProjectScopeKey("env-1:project-a");

    expect(useProjectScopeStore.getState().setProjectScopeKey).toBe(setProjectScopeKey);
  });

  it("clears back to every project", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");
    useProjectScopeStore.getState().setProjectScopeKey(null);

    expect(useProjectScopeStore.getState().projectScopeKey).toBe(null);
  });
});

// Search unification phase 1, criterion 5: `projectScope.toggleAll` flips between
// every project and the last project, through the store both surfaces write.
describe("projectScopeStore toggleAllProjects", () => {
  it("project toggle spec: from a project it switches to every project", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");

    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKey).toBe(null);
  });

  it("project toggle spec: pressed again it returns to the last project", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");
    useProjectScopeStore.getState().toggleAllProjects();

    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKey).toBe("env-1:project-a");
  });

  it("project toggle spec: with no last project it leaves every project in place", () => {
    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKey).toBe(null);
    expect(useProjectScopeStore.getState().lastProjectScopeKey).toBe(null);
  });

  it("project toggle spec: the last project is the latest one set, not the first", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-b");
    useProjectScopeStore.getState().setProjectScopeKey(null);

    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKey).toBe("env-1:project-b");
  });

  it("project toggle spec: clearing to every project keeps the last project remembered", () => {
    useProjectScopeStore.getState().setProjectScopeKey("env-1:project-a");
    useProjectScopeStore.getState().setProjectScopeKey(null);

    expect(useProjectScopeStore.getState().lastProjectScopeKey).toBe("env-1:project-a");
  });

  it("project toggle spec: a fresh store remembers no last project", () => {
    expect(useProjectScopeStore.getInitialState().lastProjectScopeKey).toBe(null);
  });
});
