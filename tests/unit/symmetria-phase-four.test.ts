// @effect-diagnostics nodeBuiltinImport:off - runs the package as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  commandOutput,
  contractPackageRoot,
  contractSourceRoot,
  expectSuccessfulCommand,
  fixturePath,
  run,
  runContractScript,
  tsgoPath,
  vitePlusPath,
} from "./contractHarness.ts";

const draftPrelude = [
  'import * as NodeFS from "node:fs";',
  'import * as Result from "effect/Result";',
  'import * as Schema from "effect/Schema";',
  'import { SymmetriaDraft, SymmetriaDraftUpdate, SymmetriaDraftUpdateResult, applySymmetriaDraftUpdate } from "@symmetria/broker-contract";',
  `const draftSource = NodeFS.readFileSync(${JSON.stringify(fixturePath("draft.golden.json"))}, "utf8");`,
  "const draftInput = JSON.parse(draftSource);",
  "const currentDraft = Schema.decodeUnknownSync(SymmetriaDraft)(draftInput);",
  `const updateInput = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("command.draftSet.json"))}, "utf8"));`,
].join("\n");

// The phase-four implementation is present in the working tree. These guards
// load the package inside a child process, so a missing module or export fails
// one guard while this test file stays collectable.
describe("Symmetria broker contract phase-four acceptance guards", () => {
  it("round-trips a draft with a monotonic version byte-identically", () => {
    const script = [
      draftPrelude,
      "const encoded = Schema.encodeSync(SymmetriaDraft)(currentDraft);",
      "const roundTrip = `${JSON.stringify(encoded, null, 2)}\\n`;",
      'if (roundTrip !== draftSource) throw new Error("golden fixture changed during decode and encode");',
      'if (!Number.isInteger(currentDraft.version) || currentDraft.version < 0) throw new Error("draft version is not a non-negative integer");',
      "for (const invalidVersion of [-1, 1.5]) {",
      "  const result = Schema.decodeUnknownResult(SymmetriaDraft)({ ...draftInput, version: invalidVersion });",
      "  if (Result.isSuccess(result)) throw new Error(`draft accepted invalid version ${String(invalidVersion)}`);",
      "}",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("requires expectedVersion on every draft update", () => {
    const script = [
      draftPrelude,
      "const valid = Schema.decodeUnknownResult(SymmetriaDraftUpdate)(updateInput);",
      "if (Result.isFailure(valid)) throw new Error(`complete draft update failed: ${valid.failure.message}`);",
      "const withoutExpectedVersion = { ...updateInput };",
      "delete withoutExpectedVersion.expectedVersion;",
      "const missing = Schema.decodeUnknownResult(SymmetriaDraftUpdate)(withoutExpectedVersion);",
      'if (Result.isSuccess(missing)) throw new Error("draft update decoded without expectedVersion");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("applies a matching expectedVersion and increments the version by exactly one", () => {
    const script = [
      draftPrelude,
      "const nextText = `${currentDraft.text} updated`;",
      "const update = Schema.decodeUnknownSync(SymmetriaDraftUpdate)({ ...updateInput, expectedVersion: currentDraft.version, text: nextText });",
      "const result = Schema.decodeUnknownSync(SymmetriaDraftUpdateResult)(applySymmetriaDraftUpdate(currentDraft, update));",
      'if (result.outcome !== "applied") throw new Error(`matching update produced ${String(result.outcome)}`);',
      "if (result.draft.version !== currentDraft.version + 1) throw new Error(`version advanced from ${String(currentDraft.version)} to ${String(result.draft.version)}`);",
      'if (result.draft.text !== nextText) throw new Error("applied result did not carry the update body");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("does not move updatedAt backwards when the writer clock is behind", () => {
    const script = [
      draftPrelude,
      'const earlierCreatedAt = "2020-01-01T00:00:00.000Z";',
      "const update = Schema.decodeUnknownSync(SymmetriaDraftUpdate)({ ...updateInput, expectedVersion: currentDraft.version, createdAt: earlierCreatedAt });",
      "const result = applySymmetriaDraftUpdate(currentDraft, update);",
      'if (result.outcome !== "applied") throw new Error(`matching update produced ${String(result.outcome)}`);',
      'if (result.draft.version !== currentDraft.version + 1) throw new Error("clock-skewed update did not advance the version");',
      "if (result.draft.updatedAt !== currentDraft.updatedAt) throw new Error(`updatedAt moved from ${currentDraft.updatedAt} to ${result.draft.updatedAt}`);",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("refuses a matching-version update addressed to another thread", () => {
    const script = [
      draftPrelude,
      "const update = Schema.decodeUnknownSync(SymmetriaDraftUpdate)({ ...updateInput, threadId: 'thr_ffffffff', expectedVersion: currentDraft.version, text: 'words for another thread' });",
      "const result = applySymmetriaDraftUpdate(currentDraft, update);",
      'if (result.outcome !== "conflict") throw new Error(`wrong-thread update produced ${String(result.outcome)}`);',
      'if (result.currentVersion !== currentDraft.version) throw new Error("wrong-thread conflict did not report the current version");',
      'if (JSON.stringify(result.currentDraft) !== JSON.stringify(currentDraft)) throw new Error("wrong-thread update changed the current draft");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("returns the current version and draft body for a stale update", () => {
    const script = [
      draftPrelude,
      'if (currentDraft.version === 0) throw new Error("golden draft version cannot express a stale update");',
      "const update = Schema.decodeUnknownSync(SymmetriaDraftUpdate)({ ...updateInput, expectedVersion: currentDraft.version - 1 });",
      "const result = Schema.decodeUnknownSync(SymmetriaDraftUpdateResult)(applySymmetriaDraftUpdate(currentDraft, update));",
      'if (result.outcome !== "conflict") throw new Error(`stale update produced ${String(result.outcome)}`);',
      'if (result.currentVersion !== currentDraft.version) throw new Error("conflict did not report the current version");',
      'if (JSON.stringify(result.currentDraft) !== JSON.stringify(currentDraft)) throw new Error("conflict did not report the current draft body");',
      `const conflictSource = NodeFS.readFileSync(${JSON.stringify(fixturePath("draft.conflict.json"))}, "utf8");`,
      "const encoded = Schema.encodeSync(SymmetriaDraftUpdateResult)(result);",
      "const roundTrip = `${JSON.stringify(encoded, null, 2)}\\n`;",
      'if (roundTrip !== conflictSource) throw new Error("typed conflict does not match its golden fixture");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("refuses an expectedVersion ahead of the current version as a conflict", () => {
    const script = [
      draftPrelude,
      "const update = Schema.decodeUnknownSync(SymmetriaDraftUpdate)({ ...updateInput, expectedVersion: currentDraft.version + 1, text: currentDraft.text });",
      "const result = Schema.decodeUnknownSync(SymmetriaDraftUpdateResult)(applySymmetriaDraftUpdate(currentDraft, update));",
      'if (result.outcome !== "conflict") throw new Error(`future update produced ${String(result.outcome)}`);',
      'if (result.currentVersion !== currentDraft.version) throw new Error("future-version conflict did not report the current version");',
      'if (JSON.stringify(result.currentDraft) !== JSON.stringify(currentDraft)) throw new Error("future-version conflict did not report the current draft body");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("refuses a conflict whose repeated versions disagree", () => {
    const script = [
      draftPrelude,
      `const conflict = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("draft.conflict.json"))}, "utf8"));`,
      "const valid = Schema.decodeUnknownResult(SymmetriaDraftUpdateResult)(conflict);",
      "if (Result.isFailure(valid)) throw new Error(`valid conflict failed: ${valid.failure.message}`);",
      "const disagreement = Schema.decodeUnknownResult(SymmetriaDraftUpdateResult)({ ...conflict, currentVersion: conflict.currentDraft.version + 1 });",
      'if (Result.isSuccess(disagreement)) throw new Error("conflict decoded with two different current versions");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps the draft body limited to composer fields and drops transcripts", () => {
    const script = [
      draftPrelude,
      "const privateInput = {",
      "  ...draftInput,",
      '  transcript: [{ role: "user", text: "private message" }],',
      '  messages: [{ id: "message-1", text: "private message" }],',
      '  providerPayload: { secret: "provider-native" },',
      "};",
      "const decoded = Schema.decodeUnknownSync(SymmetriaDraft)(privateInput);",
      "const encoded = Schema.encodeSync(SymmetriaDraft)(privateInput);",
      'for (const [direction, value] of [["decode", decoded], ["encode", encoded]]) {',
      '  for (const key of ["transcript", "messages", "providerPayload"]) {',
      "    if (Object.hasOwn(value, key)) throw new Error(`${direction} leaked ${key}`);",
      "  }",
      "}",
      'const allowedBodyKeys = new Set(["text"]);',
      'const metadataKeys = new Set(["threadId", "version", "updatedAt", "protocolVersion"]);',
      "for (const key of Object.keys(decoded)) {",
      "  if (!allowedBodyKeys.has(key) && !metadataKeys.has(key)) throw new Error(`draft exposed non-composer field ${key}`);",
      "}",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps the phase-four package tests collected and passing", () => {
    const result = run(vitePlusPath, ["test", "run", "--reporter=verbose"], contractPackageRoot);
    expectSuccessfulCommand(result);
    expect(commandOutput(result)).toContain("src/draft.test.ts");
  }, 30_000);

  it("keeps the phase-four package source green under tsgo --noEmit", () => {
    expect(NodeFS.existsSync(NodePath.join(contractSourceRoot, "draft.ts"))).toBe(true);
    expectSuccessfulCommand(run(tsgoPath, ["--noEmit"], contractPackageRoot));
  });
});
