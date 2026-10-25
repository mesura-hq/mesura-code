/**
 * Phase 3 of the search unification cycle, criterion 7: the hidden search
 * project (ADR-010) appears in no settings project list. Entry point: the
 * `useSettingsProjectGroups` hook every settings project list reads
 * (`ProjectSettingsPanel`, `SettingsScopeContext`, `ProjectIconFileDialog`),
 * rendered through a probe that lists the group names it returns. Boundaries
 * replaced: the projects atom the shell snapshot feeds (so the app's own
 * `useProjects` runs), the environment and client settings reads.
 */
import { THREAD_SEARCH_PROJECT_ID } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const ENVIRONMENT_ID = "settings-search-project-environment";

const reads = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock(import("../../state/projects"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    ...actual,
    environmentProjects: {
      ...actual.environmentProjects,
      projectsAtom: Atom.make(() => reads.projects) as never,
    },
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: ENVIRONMENT_ID, label: "Settings fence" }],
    isReady: true,
  })) as never,
  usePrimaryEnvironmentId: (() => ENVIRONMENT_ID) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    ...(await original()),
    useClientSettings: ((select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select(DEFAULT_CLIENT_SETTINGS)) as never,
  };
});

import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

function project(id: string, title: string, workspaceRoot: string) {
  return {
    id,
    environmentId: ENVIRONMENT_ID,
    title,
    workspaceRoot,
    scripts: [],
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  };
}

function GroupNames() {
  const groups = useSettingsProjectGroups();
  return (
    <ul>
      {groups.map((group) => (
        <li key={group.projectKey}>{group.displayName}</li>
      ))}
    </ul>
  );
}

it("settings project groups spec: the hidden search project is not a settings project", async () => {
  reads.projects = [
    project("settings-ordinary-project", "Ordinary workspace", "/tmp/settings-ordinary"),
    project(THREAD_SEARCH_PROJECT_ID, "Thread searches", "/tmp/state/thread-search-workspace"),
  ];
  // The probe reads no route.
  await using screen = await render(<GroupNames />, { router: false });

  const names = [...screen.container.querySelectorAll("li")].map((item) => item.textContent);
  expect(names).toEqual(["Ordinary workspace"]);
});
