import { assert, describe, it } from "@effect/vitest";
import { ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { museInitializeParams } from "@t3tools/provider-muse/testing";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { materializeMuseReplayApplicationMetadata } from "./MesuraReplayMuseMetadata.ts";

const decodeTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);
const recordedFrame = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },
    capabilities: { requestedCapabilities: ["sessionMcp"] },
  },
};
const makeTranscript = (entries: ProviderReplayTranscript["entries"]) =>
  decodeTranscript({
    provider: "muse",
    protocol: "muse.msp-jsonl",
    version: "1",
    scenario: "mesura-muse-client-metadata",
    entries,
  });

describe("Mesura Muse replay client metadata", () => {
  it("changes only the initialize display title for every recorded Muse host", () => {
    const entries = [
      { type: "expect_outbound", label: "initialize", frame: recordedFrame },
      { type: "emit_inbound", frame: recordedFrame },
      { type: "expect_outbound", frame: { ...recordedFrame, method: "session/start" } },
      { type: "expect_outbound", label: "initialize@h2", frame: recordedFrame },
      { type: "runtime_exit", status: "success" },
    ] as const satisfies ProviderReplayTranscript["entries"];
    const original = makeTranscript(entries);
    const result = materializeMuseReplayApplicationMetadata(original);
    const currentFrame = { ...recordedFrame, params: museInitializeParams() };
    assert.deepEqual(result.entries, [
      { ...entries[0], frame: currentFrame },
      entries[1],
      entries[2],
      { ...entries[3], frame: currentFrame },
      entries[4],
    ]);
    assert.deepEqual(original.entries, entries);
    assert.deepEqual(materializeMuseReplayApplicationMetadata(result), result);
  });

  it("retains mismatched Muse identifiers, versions, capabilities and unknown protocol fields", () => {
    const params = {
      clientInfo: { ...recordedFrame.params.clientInfo, name: "wrong-client", version: "99" },
      capabilities: { requestedCapabilities: ["unexpected-capability"] },
      futureField: { strict: true },
    };
    const frame = { ...recordedFrame, jsonrpc: "unexpected-envelope", params };
    assert.deepEqual(
      materializeMuseReplayApplicationMetadata(makeTranscript([{ type: "expect_outbound", frame }]))
        .entries,
      [
        {
          type: "expect_outbound",
          frame: {
            ...frame,
            params: {
              ...params,
              clientInfo: { ...params.clientInfo, title: museInitializeParams().clientInfo.title },
            },
          },
        },
      ],
    );
  });

  it("leaves non-Muse transcripts and malformed Muse initialize records untouched", () => {
    const muse = makeTranscript([{ type: "expect_outbound", frame: recordedFrame }]);
    for (const transcript of [
      { ...muse, provider: "codex" },
      { ...muse, protocol: "unexpected-protocol" },
    ]) {
      assert.strictEqual(materializeMuseReplayApplicationMetadata(transcript), transcript);
    }
    const malformed = makeTranscript([
      { type: "expect_outbound", frame: { ...recordedFrame, params: null } },
      { type: "expect_outbound", frame: { ...recordedFrame, params: { clientInfo: null } } },
      {
        type: "expect_outbound",
        frame: { ...recordedFrame, params: { clientInfo: { title: 3 } } },
      },
    ]);
    assert.deepEqual(
      materializeMuseReplayApplicationMetadata(malformed).entries,
      malformed.entries,
    );
  });

  it("changes only the first Muse runtime context title and preserves user input and protocol drift", () => {
    const currentInstructions = buildRuntimeInstructions({
      harness: "Muse Code",
      model: "muse-spark-1.3-contributor",
      reasoningEffort: "high",
    });
    const recordedInstructions = currentInstructions.replace("Mesura Code", "T3 Code");
    const userPart = { type: "text", text: recordedInstructions };
    const params = {
      input: [{ type: "text", text: recordedInstructions }, userPart],
      reasoningEffort: "unexpected-effort",
      displayText: "T3 Code remains user text",
    };
    const frame = { ...recordedFrame, method: "turn/start", params };
    const entries = [
      { type: "expect_outbound", frame },
      { type: "emit_inbound", frame },
      { type: "expect_outbound", frame: { ...frame, method: "session/start" } },
      { type: "expect_outbound", frame: { ...frame, params: { ...params, input: [userPart] } } },
    ] as const satisfies ProviderReplayTranscript["entries"];
    const original = makeTranscript(entries);
    const expectedFrame = {
      ...frame,
      params: { ...params, input: [{ type: "text", text: currentInstructions }, userPart] },
    };
    const materialized = materializeMuseReplayApplicationMetadata(original);
    assert.deepEqual(materializeMuseReplayApplicationMetadata(materialized), materialized);
    assert.deepEqual(original.entries, entries);
    assert.deepEqual(materialized.entries, [
      { ...entries[0], frame: expectedFrame },
      entries[1],
      entries[2],
      {
        ...entries[3],
        frame: {
          ...frame,
          params: { ...params, input: [{ type: "text", text: currentInstructions }] },
        },
      },
    ]);
    const changedHarness = makeTranscript([
      {
        type: "expect_outbound",
        frame: {
          ...frame,
          params: {
            ...params,
            input: [
              {
                type: "text",
                text: recordedInstructions.replace("Muse Code harness", "other harness"),
              },
            ],
          },
        },
      },
    ]);
    assert.deepEqual(
      materializeMuseReplayApplicationMetadata(changedHarness).entries,
      changedHarness.entries,
    );
  });

  it.effect(
    "materializes the simple Muse recording into the exact current SDK initialize request",
    () =>
      Effect.gen(function* () {
        const transcript = yield* readProviderReplayTranscript(
          new URL("./fixtures/simple/muse_transcript.ndjson", import.meta.url),
        );
        const result = materializeMuseReplayApplicationMetadata(transcript);
        const initialize = result.entries.find(
          (entry) => entry.type === "expect_outbound" && entry.label === "initialize",
        );
        assert.deepEqual(initialize, {
          type: "expect_outbound",
          label: "initialize",
          frame: { ...recordedFrame, params: museInitializeParams() },
        });
        const start = result.entries.find(
          (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
        );
        assert.isDefined(start);
        assert.strictEqual(start?.type, "expect_outbound");
        if (start?.type !== "expect_outbound") return assert.fail("Expected the Muse turn request");
        assert.propertyVal(start.frame, "method", "turn/start");
        assert.nestedPropertyVal(
          start.frame,
          "params.input.0.text",
          buildRuntimeInstructions({
            harness: "Muse Code",
            model: "muse-spark-1.3-contributor",
            reasoningEffort: "high",
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
