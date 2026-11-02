import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useProjectScopeStore } from "./projectScopeStore";

beforeEach(() => {
  // Replace, not merge: the toggle's memory of the last project must not leak between tests.
  useProjectScopeStore.setState(useProjectScopeStore.getInitialState(), true);
});

describe("projectScopeStore", () => {
  it("starts on every project, so a filter can never hide threads at boot", () => {
    // Read the module's own initial state, not what beforeEach wrote. This does NOT prove
    // the scope is unpersisted: this suite has no localStorage, and asserting the absence
    // of zustand's `persist` key would test zustand's API surface, not our behaviour.
    expect(useProjectScopeStore.getInitialState().projectScopeKeys).toEqual([]);
  });

  it("scopes the thread list to one project or several", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual(["env-1:project-a"]);
  });

  it("replaces the scope rather than accumulating scopes", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-b"]);

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual(["env-1:project-b"]);
  });

  it("keeps the setter's identity stable across scope changes", () => {
    // Sidebar.tsx selects the value and the setter separately. That is only
    // cheap while the setter's reference survives a state change; an action
    // rebuilt on every set would re-render the sidebar on every filter change
    // for no reason, and nothing else would notice.
    const setProjectScopeKeys = useProjectScopeStore.getState().setProjectScopeKeys;

    setProjectScopeKeys(["env-1:project-a"]);

    expect(useProjectScopeStore.getState().setProjectScopeKeys).toBe(setProjectScopeKeys);
  });

  it("clears back to every project", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);
    useProjectScopeStore.getState().setProjectScopeKeys([]);

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual([]);
  });
});

// Search unification phase 1, criterion 5: `projectScope.toggleAll` flips between
// every project and the last project, through the store both surfaces write.
describe("projectScopeStore toggleAllProjects", () => {
  it("project toggle spec: from a project it switches to every project", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);

    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual([]);
  });

  it("project toggle spec: pressed again it returns to the last project", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);
    useProjectScopeStore.getState().toggleAllProjects();

    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual(["env-1:project-a"]);
  });

  it("project toggle spec: with no last project it leaves every project in place", () => {
    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual([]);
    expect(useProjectScopeStore.getState().lastProjectScopeKeys).toEqual([]);
  });

  it("project toggle spec: the last project is the latest one set, not the first", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-b"]);
    useProjectScopeStore.getState().setProjectScopeKeys([]);

    useProjectScopeStore.getState().toggleAllProjects();

    expect(useProjectScopeStore.getState().projectScopeKeys).toEqual(["env-1:project-b"]);
  });

  it("project toggle spec: clearing to every project keeps the last project remembered", () => {
    useProjectScopeStore.getState().setProjectScopeKeys(["env-1:project-a"]);
    useProjectScopeStore.getState().setProjectScopeKeys([]);

    expect(useProjectScopeStore.getState().lastProjectScopeKeys).toEqual(["env-1:project-a"]);
  });

  it("project toggle spec: a fresh store remembers no last project", () => {
    expect(useProjectScopeStore.getInitialState().lastProjectScopeKeys).toEqual([]);
  });
});
