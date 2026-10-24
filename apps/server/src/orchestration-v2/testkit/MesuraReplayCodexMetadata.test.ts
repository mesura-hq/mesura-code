import { ProviderReplayTranscript } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../../package.json" with { type: "json" };
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { materializeCodexReplayClientMetadata } from "./MesuraReplayCodexMetadata.ts";

const recordedParams = {
  clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" },
  capabilities: {
    experimentalApi: true,
    optOutNotificationMethods: ["turn/diff/updated"],
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  },
};
const currentParams = {
  ...recordedParams,
  clientInfo: { ...recordedParams.clientInfo, title: "Mesura Code", version: packageJson.version },
};
const recordedFrame = { id: 1, method: "initialize", params: recordedParams };
const decodeProviderReplayTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);
const isCodexReplayFrameMismatchError = Schema.is(
  CodexReplay.CodexAppServerReplayFrameMismatchError,
);
const makeTranscript = (entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>) =>
  decodeProviderReplayTranscript({
    provider: "codex",
    protocol: "codex.app-server",
    version: "1",
    scenario: "mesura-codex-client-metadata",
    entries,
  });

const replayInitialize = (params: unknown, expectedFrame: unknown = recordedFrame) =>
  Effect.gen(function* () {
    const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
      makeTranscript([
        { type: "expect_outbound", frame: expectedFrame },
        { type: "emit_inbound", frame: { id: 1, result: { userAgent: "codex-test" } } },
      ]),
    );
    const driver = yield* CodexReplay.makeReplayDriver(transcript);
    const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(context),
    );
    const response = yield* client.raw.request("initialize", params).pipe(Effect.exit);
    return { response, state: yield* Ref.get(driver.state) };
  }).pipe(Effect.scoped);

describe("Mesura Codex replay client metadata", () => {
  it.effect(
    "materializes only recorded Codex initialize title and version at the harness boundary",
    () =>
      Effect.gen(function* () {
        const entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> = [
          { type: "expect_outbound", label: "initialize-first", frame: recordedFrame },
          { type: "emit_inbound", frame: recordedFrame },
          { type: "expect_outbound", frame: { ...recordedFrame, method: "thread/start" } },
          { type: "expect_outbound", label: "initialize-restart", frame: recordedFrame },
          { type: "runtime_exit", status: "success" },
        ];
        const original = makeTranscript(entries);
        const materialized = yield* CodexOrchestratorReplayHarness.decodeTranscript(original);
        const [firstInitialize, inboundInitialize, threadStart, restartInitialize, runtimeExit] =
          entries;
        if (
          firstInitialize === undefined ||
          inboundInitialize === undefined ||
          threadStart === undefined ||
          restartInitialize === undefined ||
          runtimeExit === undefined
        ) {
          return assert.fail("Expected all five Codex metadata fixture entries");
        }
        if (
          firstInitialize.type !== "expect_outbound" ||
          inboundInitialize.type !== "emit_inbound" ||
          threadStart.type !== "expect_outbound" ||
          restartInitialize.type !== "expect_outbound" ||
          runtimeExit.type !== "runtime_exit"
        ) {
          return assert.fail("Expected the recorded Codex metadata fixture entry types");
        }
        assert.deepEqual(materialized.entries, [
          { ...firstInitialize, frame: { ...recordedFrame, params: currentParams } },
          inboundInitialize,
          threadStart,
          { ...restartInitialize, frame: { ...recordedFrame, params: currentParams } },
          runtimeExit,
        ]);
        assert.deepEqual(original.entries, entries);
        assert.deepEqual(
          yield* CodexOrchestratorReplayHarness.decodeTranscript(
            makeTranscript(materialized.entries),
          ),
          materialized,
        );
      }),
  );

  it.effect("replays current Codex initialize metadata against a legacy expected frame", () =>
    Effect.gen(function* () {
      const result = yield* replayInitialize(currentParams);
      assert.deepEqual(result.response, Exit.succeed({ userAgent: "codex-test" }));
      assert.deepEqual(result.state, { cursor: 2, failure: null });
    }),
  );

  // The replay matcher already ignores clientInfo.version. A rejection assertion hung
  // because the request matched; materialization must preserve this existing behavior.
  it.effect("preserves the Codex replay matcher's existing initialize version normalization", () =>
    Effect.gen(function* () {
      const result = yield* replayInitialize({
        ...currentParams,
        clientInfo: { ...currentParams.clientInfo, version: "another-recording-version" },
      });
      assert.deepEqual(result.response, Exit.succeed({ userAgent: "codex-test" }));
      assert.deepEqual(result.state, { cursor: 2, failure: null });
    }),
  );

  it("leaves incomplete Codex initialize metadata and other provider transcripts unchanged", () => {
    const entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> = [
      { type: "expect_outbound", frame: null },
      { type: "expect_outbound", frame: { method: "initialize", params: null } },
      { type: "expect_outbound", frame: { method: "initialize", params: { clientInfo: null } } },
      {
        type: "expect_outbound",
        frame: { method: "initialize", params: { clientInfo: { name: "T3 Code" } } },
      },
    ];
    const transcript = makeTranscript(entries);
    assert.deepEqual(materializeCodexReplayClientMetadata(transcript), transcript);
    const otherProvider = {
      ...makeTranscript([{ type: "expect_outbound", frame: recordedFrame }]),
      provider: "other-provider",
    };
    assert.strictEqual(materializeCodexReplayClientMetadata(otherProvider), otherProvider);
    const otherProtocol = { ...otherProvider, provider: "codex", protocol: "other-protocol" };
    assert.strictEqual(materializeCodexReplayClientMetadata(otherProtocol), otherProtocol);
  });

  it.effect("retains an unexpected recorded Codex client identifier as a replay mismatch", () =>
    Effect.gen(function* () {
      const params = {
        ...recordedParams,
        clientInfo: { ...recordedParams.clientInfo, name: "unexpected-recorded-client" },
      };
      const result = yield* replayInitialize(currentParams, { ...recordedFrame, params });
      assert.isTrue(isCodexReplayFrameMismatchError(result.state.failure));
      assert.strictEqual(result.state.cursor, 0);
    }),
  );

  it.effect.each([
    [
      "client identifier",
      { ...currentParams, clientInfo: { ...currentParams.clientInfo, name: "Mesura Code" } },
    ],
    [
      "unexpected title",
      { ...currentParams, clientInfo: { ...currentParams.clientInfo, title: "Wrong title" } },
    ],
    [
      "experimental API",
      { ...currentParams, capabilities: { ...currentParams.capabilities, experimentalApi: false } },
    ],
    [
      "notification opt-outs",
      {
        ...currentParams,
        capabilities: { ...currentParams.capabilities, optOutNotificationMethods: [] },
      },
    ],
    [
      "MCP UI extension",
      { ...currentParams, capabilities: { ...currentParams.capabilities, extensions: {} } },
    ],
    ["extra protocol field", { ...currentParams, unexpected: true }],
  ] as const)("rejects Codex initialize %s drift after metadata materialization", ([, params]) =>
    Effect.gen(function* () {
      const { state } = yield* replayInitialize(params);
      assert.strictEqual(state.cursor, 0);
      if (!isCodexReplayFrameMismatchError(state.failure)) {
        return assert.fail("Expected a Codex replay frame mismatch");
      }
      assert.deepEqual(state.failure.expected, { ...recordedFrame, params: currentParams });
      assert.deepEqual(state.failure.actual, { ...recordedFrame, params });
    }),
  );
});
