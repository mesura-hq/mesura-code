import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import { makeScriptedQuestionPeer } from "../../testUtils/scriptedQuestionPeer.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

it.effect("Codex delivers complete answer arrays through its native callback", () =>
  Effect.gen(function* () {
    const values = [" Workspace\t", "Session", "Keep both scopes active"];
    const peer = yield* makeScriptedQuestionPeer((message) => {
      if (message.method === "initialize")
        return [
          {
            id: message.id,
            result: {
              userAgent: "question-fence",
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "linux",
            },
          },
        ];
      if (message.method === "thread/start")
        return [{ id: message.id, result: wireFixture.responses.threadStart }];
      return [];
    });
    yield* Effect.gen(function* () {
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("phase-one-codex-question"),
        binaryPath: "question-peer",
        cwd: "/tmp",
        runtimeMode: "full-access",
      });
      const requested = yield* Deferred.make<ProviderEvent>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          event.method === "item/tool/requestUserInput"
            ? Deferred.succeed(requested, event).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* peer.send({
        jsonrpc: "2.0",
        id: 7101,
        method: "item/tool/requestUserInput",
        params: {
          threadId: wireFixture.rootThreadId,
          turnId: wireFixture.responses.turnStart.turn.id,
          itemId: "question-item",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scopes?",
              options: values.slice(0, 2).map((label) => ({ label, description: label })),
            },
          ],
        },
      });
      const request = yield* Deferred.await(requested);
      if (request.requestId === undefined) throw new Error("Codex did not expose the request ID");
      yield* runtime.respondToUserInput(request.requestId, { scope: values });
      const response = yield* Stream.fromQueue(peer.received).pipe(
        Stream.filter((message) => message.id === 7101),
        Stream.runHead,
      );
      expect(response).toMatchObject({
        _tag: "Some",
        value: {
          id: 7101,
          result: { answers: { scope: { answers: values } } },
        },
      });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
