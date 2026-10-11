/**
 * Entry point: `createEnvironmentRpcQueryAtomFamily`, configured the way
 * `apps/web/src/state/issues.ts` configures `issueList` and `issueDetail`, reached through the
 * real `request` path over one fake RPC session per environment.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type IssueDetail,
  type IssueDetailInput,
  type IssueListInput,
  type IssueListResult,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const firstEnvironmentId = EnvironmentId.make("issues-environment-a");
const secondEnvironmentId = EnvironmentId.make("issues-environment-b");
// The same project id and issue number exist on both environments.
const projectId = ProjectId.make("shared-project-id");
const listInput: IssueListInput = { projectId, state: "open", query: "", limit: 25 };
const detailInput: IssueDetailInput = { projectId, number: 7 };

function issueFrom(environmentId: EnvironmentId, number: number): IssueDetail {
  return {
    number,
    title: `Issue ${number} on ${environmentId}`,
    url: `https://github.com/${environmentId}/app/issues/${number}`,
    state: "OPEN",
    author: { login: environmentId },
    assignees: [],
    labels: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    body: `Body from ${environmentId}`,
    comments: [],
  };
}

const makeTwoEnvironmentRuntime = Effect.fn("TestIssueQueries.makeRuntime")(function* () {
  const requests: Array<readonly [EnvironmentId, string]> = [];
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  for (const environmentId of [firstEnvironmentId, secondEnvironmentId]) {
    const client = {
      [WS_METHODS.issuesList]: (input: IssueListInput) =>
        Effect.sync((): IssueListResult => {
          requests.push([environmentId, WS_METHODS.issuesList]);
          const { body: _body, comments: _comments, ...summary } = issueFrom(environmentId, 7);
          return {
            repository: `${environmentId}/app`,
            repositoryUrl: `https://github.com/${environmentId}/app`,
            issues: [summary].slice(0, input.limit),
            hasMore: false,
          };
        }),
      [WS_METHODS.issuesDetail]: (input: IssueDetailInput) =>
        Effect.sync(() => {
          requests.push([environmentId, WS_METHODS.issuesDetail]);
          return issueFrom(environmentId, input.number);
        }),
    } as unknown as WsRpcProtocolClient;
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: `https://${environmentId}.test`,
          wsBaseUrl: `wss://${environmentId}.test`,
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const environments = EnvironmentRegistry.of({
    run: (id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(id)!),
    followStream: (id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(id)!),
  } as EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return {
    requests,
    registry,
    issueList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "test:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
    issueDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "test:issues:detail",
      tag: WS_METHODS.issuesDetail,
      staleTimeMs: 30_000,
    }),
  };
});

describe("environment-scoped issue queries", () => {
  it.effect(
    "keeps identical issue detail targets on different environments in separate caches",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTwoEnvironmentRuntime();
          const first = harness.issueDetail({
            environmentId: firstEnvironmentId,
            input: detailInput,
          });
          const second = harness.issueDetail({
            environmentId: secondEnvironmentId,
            input: detailInput,
          });
          const firstAgain = harness.issueDetail({
            environmentId: firstEnvironmentId,
            input: { ...detailInput },
          });

          expect(first).not.toBe(second);
          expect(firstAgain).toBe(first);
          const firstDetail = yield* AtomRegistry.getResult(harness.registry, first, {
            suspendOnWaiting: true,
          });
          const secondDetail = yield* AtomRegistry.getResult(harness.registry, second, {
            suspendOnWaiting: true,
          });
          expect(firstDetail.body).toBe(`Body from ${firstEnvironmentId}`);
          expect(secondDetail.body).toBe(`Body from ${secondEnvironmentId}`);
          expect(harness.requests).toEqual([
            [firstEnvironmentId, WS_METHODS.issuesDetail],
            [secondEnvironmentId, WS_METHODS.issuesDetail],
          ]);
        }),
      ),
  );

  it.effect("keeps identical issue list targets on different environments in separate caches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeTwoEnvironmentRuntime();
        const first = harness.issueList({ environmentId: firstEnvironmentId, input: listInput });
        const second = harness.issueList({ environmentId: secondEnvironmentId, input: listInput });

        expect(first).not.toBe(second);
        const firstList = yield* AtomRegistry.getResult(harness.registry, first, {
          suspendOnWaiting: true,
        });
        const secondList = yield* AtomRegistry.getResult(harness.registry, second, {
          suspendOnWaiting: true,
        });
        expect(firstList.repository).toBe(`${firstEnvironmentId}/app`);
        expect(secondList.repository).toBe(`${secondEnvironmentId}/app`);
        expect(harness.requests).toEqual([
          [firstEnvironmentId, WS_METHODS.issuesList],
          [secondEnvironmentId, WS_METHODS.issuesList],
        ]);
      }),
    ),
  );

  it.effect("sends no issue request until an issue query atom is read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeTwoEnvironmentRuntime();
        harness.issueList({ environmentId: firstEnvironmentId, input: listInput });
        harness.issueDetail({ environmentId: secondEnvironmentId, input: detailInput });
        yield* Effect.yieldNow;
        expect(harness.requests).toEqual([]);
      }),
    ),
  );
});
