// Mesura: the read-only `find_threads` MCP tool (ADR-010), called through the
// MCP server `McpHttpServer.toolkitRegistration` builds. The broker is a fake
// that records the forwarded call; `../../ThreadSearchBroker.test.ts` covers it.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadSearchToolResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { ThreadSearchBroker } from "../../ThreadSearchBroker.ts";
import * as ThreadSearchHandlers from "./handlers.ts";
import { ThreadSearchToolkit } from "./tools.ts";

const SEARCH_THREAD_ID = ThreadId.make("thread-search-conversation");
const FOUND_THREAD_ID = ThreadId.make("thread-found-archived");

const BROKER_RESULT: ThreadSearchToolResult = {
  status: "matches",
  matches: [
    {
      environmentId: EnvironmentId.make("environment-1"),
      environmentLabel: "vigilia-home",
      threadId: FOUND_THREAD_ID,
      projectId: ProjectId.make("project-mesura"),
      threadTitle: "Cache review",
      projectTitle: "Mesura Code",
      archivedAt: "2026-06-03T00:00:00.000Z",
      reason: "Jev · evidence 95%: The cache used the wall clock instead of the monotonic one.",
      url: `t3-thread://v1/${FOUND_THREAD_ID}`,
    },
  ],
  coverage: {
    unavailableEnvironments: [
      { environmentId: EnvironmentId.make("environment-2"), label: "laptop" },
    ],
    budgetExhausted: true,
    unreadEvidence: false,
  },
  detail: "Assess the returned evidence and explain the matches.",
  engine: "jev",
};

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: SEARCH_THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "thread-search-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-search-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** The registered MCP server, with a broker that records each forwarded call. */
const makeServer = Effect.fn("ThreadSearchToolTest.makeServer")(function* () {
  const forwarded: Array<{ readonly threadId: ThreadId; readonly description: string }> = [];
  const dependencies = Layer.mergeAll(
    McpToolAccessTestkit.liveThreadsLayer,
    Layer.mock(ThreadSearchBroker)({
      invoke: (threadId, description) =>
        Effect.sync(() => {
          forwarded.push({ threadId, description });
          return BROKER_RESULT;
        }),
    }),
  );
  const registration = McpHttpServer.toolkitRegistration(
    ThreadSearchToolkit,
    ThreadSearchHandlers.layer,
  ).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(dependencies));
  const server = yield* McpServer.McpServer.pipe(Effect.provide(registration));
  const call = (
    description: string,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  ) =>
    server
      .callTool({ name: "find_threads", arguments: { description } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  return { server, call, forwarded };
});

it.layer(NodeServices.layer)("find_threads MCP tool", (it) => {
  describe("capability", () => {
    it.effect("find_threads spec: a session without thread-search gets a capability error", () =>
      Effect.gen(function* () {
        const harness = yield* makeServer();
        // Every capability an ordinary thread credential carries, and no more.
        const denied = yield* harness.call("the cache clock bug", [
          "preview",
          "orchestration",
          "worktree",
          "pull-requests",
          "factory",
          "project-icons",
        ]);
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual([
          { type: "text", text: "MCP credential does not grant the thread-search capability." },
        ]);
        expect(harness.forwarded).toEqual([]);
      }),
    );

    it.effect("find_threads spec: a search session forwards its call to the broker", () =>
      Effect.gen(function* () {
        const harness = yield* makeServer();
        const answered = yield* harness.call("the cache clock bug", ["thread-search"]);
        expect(answered.isError).not.toBe(true);
        expect(harness.forwarded).toEqual([
          { threadId: SEARCH_THREAD_ID, description: "the cache clock bug" },
        ]);
        // Matches, the evidence in each reason, the app URL, the coverage
        // limits and the answering engine all reach the conversational model.
        expect(answered.structuredContent).toEqual(BROKER_RESULT);
      }),
    );
  });

  it.effect("find_threads spec: the tool is advertised read-only and non-destructive", () =>
    Effect.gen(function* () {
      const harness = yield* makeServer();
      const tool = harness.server.tools.find(({ tool }) => tool.name === "find_threads");
      expect(tool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(tool?.tool.annotations?.destructiveHint).toBe(false);
      expect(tool?.tool.description).toMatch(/t3-thread:\/\/v1/);
    }),
  );
});
