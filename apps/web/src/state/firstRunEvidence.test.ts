import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { isFreshFirstRunWorkspace } from "../onboarding/firstRun.logic";
import { makeFirstRunThreadEvidenceAtom } from "./firstRunEvidence";

const thread = (id: string, title = id) =>
  ({
    id,
    title,
    projectId: "project-1",
    environmentId: "env-1",
    latestRun: null,
    latestUserMessageAt: null,
    runtime: null,
  }) as unknown as EnvironmentThreadShell;

const fresh = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
  isFreshFirstRunWorkspace({
    primaryEnvironmentId: "env-1",
    serverCwd: "/work",
    bootstrapProjectId: "project-1",
    bootstrapThreadId: "bootstrap",
    bootstrapProjectCreated: true,
    bootstrapThreadCreated: true,
    projects: [{ id: "project-1", environmentId: "env-1", workspaceRoot: "/work" }],
    threads,
  });

it("decides from the live list: a snapshot with more threads reads as not fresh at once", () => {
  const registry = AtomRegistry.make();
  const shells = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([]);
  const evidence = makeFirstRunThreadEvidenceAtom(shells);
  const unsubscribe = registry.subscribe(evidence, () => {}, { immediate: true });

  expect(fresh(registry.get(evidence).threads)).toBe(true);
  // The startup snapshot lands with the bootstrap thread and real work. A list
  // one second behind still read "fresh" here and chose the wizard for good.
  registry.set(shells, [thread("bootstrap"), thread("work")]);
  const now = registry.get(evidence);
  expect(now.threadCount).toBe(2);
  expect(fresh(now.threads)).toBe(false);
  unsubscribe();
});

it("does not change while only the contents of many threads change", () => {
  const registry = AtomRegistry.make();
  const shells = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([thread("a"), thread("b")]);
  const evidence = makeFirstRunThreadEvidenceAtom(shells);
  const seen: unknown[] = [];
  const unsubscribe = registry.subscribe(evidence, (value) => seen.push(value), {
    immediate: true,
  });

  registry.set(shells, [thread("a", "streamed"), thread("b", "streamed")]);
  expect(seen, "a streamed update changes nothing the decision reads").toHaveLength(1);
  registry.set(shells, [thread("a"), thread("b"), thread("c")]);
  expect(registry.get(evidence).threadCount, "a new thread does").toBe(3);
  registry.set(shells, [thread("only")]);
  expect(
    registry.get(evidence).threads.map((t) => t.id),
    "and so does the last one left",
  ).toEqual(["only"]);
  unsubscribe();
});
