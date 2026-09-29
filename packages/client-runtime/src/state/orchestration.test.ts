/**
 * Guards for the orchestration atoms that exact-word thread search reads.
 * Entry point: `createOrchestrationEnvironmentAtoms`, as web and mobile build it.
 * Agent thread search adds a separate path; these pin that the lexical picker
 * still reaches only `orchestration.searchThreads` in the environment it names.
 */
import { EnvironmentId, ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { executeAtomQuery } from "./runtime.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import {
  makeFakeEnvironments,
  makeFakeThread,
  type FakeEnvironmentSpec,
} from "./threadSearchEnvironmentFakes.testFixtures.ts";

const silentReporter = { warn: () => undefined, error: () => undefined };

const specs: FakeEnvironmentSpec[] = [
  {
    environmentId: "env-laptop",
    label: "Laptop",
    threads: [
      makeFakeThread({
        threadId: "thread-active",
        projectId: "project-a",
        title: "Active",
        projectTitle: "A",
        texts: ["The needle is here."],
      }),
      makeFakeThread({
        threadId: "thread-archived",
        projectId: "project-a",
        title: "Archived",
        projectTitle: "A",
        archivedAt: "2026-02-01T00:00:00.000Z",
        texts: ["An archived needle."],
        startMinute: 5,
      }),
    ],
  },
  {
    environmentId: "env-server",
    label: "Server",
    threads: [
      makeFakeThread({
        threadId: "thread-remote",
        projectId: "project-b",
        title: "Remote",
        projectTitle: "B",
        texts: ["A remote needle."],
      }),
    ],
  },
];

it.effect(
  "orchestration guard: lexical thread search calls only searchThreads in the named environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fakes = yield* makeFakeEnvironments(specs);
        const atoms = createOrchestrationEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, fakes.registry)),
        );
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );

        const result = yield* Effect.promise(() =>
          executeAtomQuery(
            registry,
            atoms.threadSearch({
              environmentId: EnvironmentId.make("env-laptop"),
              input: { query: "needle" },
            }),
            {},
            silentReporter,
          ),
        );

        expect(fakes.calls).toEqual([
          {
            environmentId: "env-laptop",
            method: ORCHESTRATION_WS_METHODS.searchThreads,
            input: { query: "needle" },
          },
        ]);
        expect(AsyncResult.isSuccess(result)).toBe(true);
        if (AsyncResult.isSuccess(result)) {
          expect(result.value.matches.map((match) => match.threadId)).toEqual(["thread-active"]);
        }
      }),
    ),
);

it.effect(
  "orchestration guard: lexical thread search of a remote environment stays scoped to it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fakes = yield* makeFakeEnvironments(specs);
        const atoms = createOrchestrationEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, fakes.registry)),
        );
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );

        const result = yield* Effect.promise(() =>
          executeAtomQuery(
            registry,
            atoms.threadSearch({
              environmentId: EnvironmentId.make("env-server"),
              input: { query: "needle" },
            }),
            {},
            silentReporter,
          ),
        );

        expect(fakes.calls.map((call) => [call.environmentId, call.method])).toEqual([
          ["env-server", ORCHESTRATION_WS_METHODS.searchThreads],
        ]);
        expect(AsyncResult.isSuccess(result)).toBe(true);
        if (AsyncResult.isSuccess(result)) {
          expect(result.value.matches.map((match) => match.threadId)).toEqual(["thread-remote"]);
        }
      }),
    ),
);
