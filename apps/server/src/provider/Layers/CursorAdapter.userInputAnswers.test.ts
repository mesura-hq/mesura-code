import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CursorSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeScriptedQuestionPeer } from "../../testUtils/scriptedQuestionPeer.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";

const settings = Schema.decodeUnknownSync(CursorSettings)({ binaryPath: "question-peer" });

it.effect("Cursor forwards choice and note through its native callback", () =>
  Effect.gen(function* () {
    const peer = yield* makeScriptedQuestionPeer((message) => {
      if (message.method === "initialize")
        return [
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
            },
          },
        ];
      if (message.method === "session/new")
        return [{ jsonrpc: "2.0", id: message.id, result: { sessionId: "question-session" } }];
      if (message.method !== undefined && message.id !== undefined)
        return [{ jsonrpc: "2.0", id: message.id, result: {} }];
      return [];
    });
    yield* Effect.gen(function* () {
      const adapter = yield* makeCursorAdapter(settings);
      const threadId = ThreadId.make("phase-one-cursor-question");
      const requested = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId === threadId && event.type === "user-input.requested"
          ? Deferred.succeed(requested, event).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
      yield* peer.send({
        jsonrpc: "2.0",
        id: 7201,
        method: "cursor/ask_question",
        params: {
          toolCallId: "question-tool",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [{ id: "workspace", label: "Workspace" }],
            },
          ],
        },
      });
      const request = yield* Deferred.await(requested);
      if (request.type !== "user-input.requested" || request.requestId === undefined)
        throw new Error("Expected a Cursor question with a request ID");
      const answers = { scope: ["Workspace", "Keep the current files"] };
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(request.requestId),
        answers,
      );
      const response = yield* Stream.fromQueue(peer.received).pipe(
        Stream.filter((message) => message.id === 7201),
        Stream.runHead,
      );
      expect(response).toMatchObject({ _tag: "Some", value: { id: 7201, result: { answers } } });
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peer.spawner));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "cursor-question-fence-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
