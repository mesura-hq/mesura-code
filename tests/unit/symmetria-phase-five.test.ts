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
  typecheckerPath,
  vitePlusPath,
} from "./contractHarness.ts";

const schemaPrelude = [
  'import * as NodeFS from "node:fs";',
  'import * as Result from "effect/Result";',
  'import * as Schema from "effect/Schema";',
].join("\n");

const fixtureItemsScript = [
  "const fixtureItems = (fixture) => {",
  "  if (Array.isArray(fixture)) return fixture;",
  "  if (Array.isArray(fixture.items)) return fixture.items;",
  '  throw new Error("stream fixture must be an array or an object with an items array");',
  "};",
].join("\n");

// Each check loads the package inside a child process as an external consumer.
// A missing export is one test failure while this file stays collectable and
// all acceptance and regression guards run.
describe("Symmetria broker contract phase-five specifications", () => {
  it("defines snapshot and delta stream items with revision and sequence positions", () => {
    const script = [
      schemaPrelude,
      'import { SymmetriaStreamItem } from "@symmetria/broker-contract";',
      `const snapshotSource = NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.snapshot.golden.json"))}, "utf8");`,
      "const snapshot = Schema.decodeUnknownSync(SymmetriaStreamItem)(JSON.parse(snapshotSource));",
      'if (snapshot.type !== "snapshot") throw new Error(`golden item decoded as ${String(snapshot.type)}`);',
      'if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("snapshot has no non-negative revision");',
      "const snapshotEncoded = Schema.encodeSync(SymmetriaStreamItem)(snapshot);",
      "const snapshotRoundTrip = `${JSON.stringify(snapshotEncoded, null, 2)}\\n`;",
      'if (snapshotRoundTrip !== snapshotSource) throw new Error("snapshot fixture changed during decode and encode");',
      "const document = Schema.toJsonSchemaDocument(SymmetriaStreamItem);",
      "const definitions = document.definitions ?? {};",
      "const resolve = (value) => {",
      '  if (value === null || typeof value !== "object" || typeof value.$ref !== "string") return value;',
      '  const prefix = "#/$defs/";',
      "  return value.$ref.startsWith(prefix) ? definitions[value.$ref.slice(prefix.length)] ?? value : value;",
      "};",
      "const objectMembers = [];",
      "const visit = (input, seen = new Set()) => {",
      "  const value = resolve(input);",
      '  if (value === null || typeof value !== "object" || seen.has(value)) return;',
      "  seen.add(value);",
      '  if (value.type === "object" && value.properties) objectMembers.push(value);',
      "  for (const child of Object.values(value)) visit(child, seen);",
      "};",
      "visit(document.schema);",
      "const memberFor = (tag) => objectMembers.find((member) => Array.isArray(member.properties.type?.enum) && member.properties.type.enum.includes(tag));",
      'const snapshotMember = memberFor("snapshot");',
      'const deltaMember = memberFor("delta");',
      'if (snapshotMember === undefined || deltaMember === undefined) throw new Error("stream union does not contain snapshot and delta members");',
      'if (!snapshotMember.required?.includes("revision")) throw new Error("snapshot does not require revision");',
      'if (!deltaMember.required?.includes("sequence")) throw new Error("delta does not require sequence");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("rejects a delta as the first item when opening a stream", () => {
    const script = [
      schemaPrelude,
      'import { SymmetriaStreamItem, openSymmetriaStream } from "@symmetria/broker-contract";',
      fixtureItemsScript,
      `const fixture = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.duplicate.json"))}, "utf8"));`,
      'const deltaInput = fixtureItems(fixture).find((item) => item.type === "delta");',
      'if (deltaInput === undefined) throw new Error("duplicate fixture contains no delta");',
      "const delta = Schema.decodeUnknownSync(SymmetriaStreamItem)(deltaInput);",
      "const opened = openSymmetriaStream(delta);",
      'if (Result.isSuccess(opened)) throw new Error("stream opened from a delta");',
      'if (typeof opened.failure?._tag !== "string") throw new Error("opening failure is not typed");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("accepts the additive-unknown-field fixture and drops fields at every projected depth", () => {
    const script = [
      schemaPrelude,
      'import { decodeSymmetriaStreamItem } from "@symmetria/broker-contract";',
      `const input = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.unknownField.json"))}, "utf8"));`,
      "const decoded = decodeSymmetriaStreamItem(input);",
      "if (Result.isFailure(decoded)) throw new Error(`additive field was refused: ${decoded.failure._tag}`);",
      'if (decoded.success.type !== "snapshot") throw new Error("unknown-field fixture is not a snapshot");',
      "const item = decoded.success;",
      'if (!Object.hasOwn(input, "emittedAt") || Object.hasOwn(item, "emittedAt")) throw new Error("root additive field was not dropped");',
      'if (!Object.hasOwn(input.threads[0], "unreadCount") || Object.hasOwn(item.threads[0], "unreadCount")) throw new Error("thread additive field was not dropped");',
      'if (!Object.hasOwn(input.threads[0].latestTurn, "queuedBehind") || Object.hasOwn(item.threads[0].latestTurn, "queuedBehind")) throw new Error("nested turn additive field was not dropped");',
      'if (!Object.hasOwn(input.surfaces[0], "deviceLabel") || Object.hasOwn(item.surfaces[0], "deviceLabel")) throw new Error("surface additive field was not dropped");',
      'if (item.threads[0].latestTurn.turnId !== input.threads[0].latestTurn.turnId) throw new Error("dropping a nested field changed its allowlisted sibling");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps published stream vocabularies aligned with their decodable unions", () => {
    const script = [
      schemaPrelude,
      'import { SYMMETRIA_STREAM_CHANGE_ENTITIES, SYMMETRIA_STREAM_ITEM_TYPES, SymmetriaStreamChange, SymmetriaStreamItem } from "@symmetria/broker-contract";',
      `const snapshot = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.snapshot.golden.json"))}, "utf8"));`,
      "const probes = {",
      '  thread: { entity: "thread", thread: snapshot.threads[0] },',
      '  surface: { entity: "surface", surface: snapshot.surfaces[0] },',
      '  draft: { entity: "draft", draft: snapshot.drafts[0] },',
      '  project: { entity: "project", project: snapshot.projects[0] },',
      // Was `project` until the 1.1 addition made that entity real. Any name
      // this build does not publish serves — what is exercised is the fallback
      // member, not this particular word.
      '  unknown: { entity: "sprocket", sprocket: { id: "spr_future" } },',
      "};",
      "const decodedEntities = SYMMETRIA_STREAM_CHANGE_ENTITIES.map((entity) => Schema.decodeUnknownSync(SymmetriaStreamChange)(probes[entity]).entity);",
      'if (SymmetriaStreamChange.members.length !== SYMMETRIA_STREAM_CHANGE_ENTITIES.length) throw new Error("published change entity count does not match the schema union");',
      'if (JSON.stringify(decodedEntities) !== JSON.stringify(SYMMETRIA_STREAM_CHANGE_ENTITIES)) throw new Error("published change entities do not match the decodable union");',
      "const itemTypes = SymmetriaStreamItem.members.map((member) => member.fields.type.literal);",
      'if (JSON.stringify([...itemTypes].sort()) !== JSON.stringify([...SYMMETRIA_STREAM_ITEM_TYPES].sort())) throw new Error("published item types do not match the schema union");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps a future change entity in sequence without accepting malformed known entities", () => {
    const script = [
      schemaPrelude,
      'import { applySymmetriaStreamDelta, decodeSymmetriaStreamItem, openSymmetriaStream } from "@symmetria/broker-contract";',
      `const snapshotInput = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.snapshot.golden.json"))}, "utf8"));`,
      "const snapshot = decodeSymmetriaStreamItem(snapshotInput);",
      'if (Result.isFailure(snapshot) || snapshot.success.type !== "snapshot") throw new Error("golden snapshot did not decode");',
      "const opened = openSymmetriaStream(snapshot.success);",
      "if (Result.isFailure(opened)) throw new Error(`golden snapshot did not open: ${opened.failure._tag}`);",
      "const future = decodeSymmetriaStreamItem({",
      '  type: "delta",',
      "  sequence: opened.success.sequence + 1,",
      '  change: { entity: "sprocket", sprocket: { id: "spr_future" } },',
      "});",
      'if (Result.isFailure(future) || future.success.type !== "delta") throw new Error("future entity was refused");',
      'if (future.success.change.entity !== "unknown") throw new Error(`future entity decoded as ${String(future.success.change.entity)}`);',
      'if (Object.hasOwn(future.success.change, "sprocket")) throw new Error("future entity payload escaped the projection allowlist");',
      "const applied = applySymmetriaStreamDelta(opened.success, future.success);",
      'if (applied.outcome !== "applied" || applied.requiresResnapshot !== false) throw new Error("future entity forced a resnapshot");',
      'if (applied.state.sequence !== opened.success.sequence + 1) throw new Error("future entity did not consume its sequence");',
      'for (const key of ["threads", "surfaces", "drafts", "projects"]) {',
      "  if (JSON.stringify(applied.state[key]) !== JSON.stringify(opened.success[key])) throw new Error(`future entity changed ${key}`);",
      "}",
      "const malformedKnown = decodeSymmetriaStreamItem({",
      '  type: "delta",',
      "  sequence: opened.success.sequence + 1,",
      '  change: { entity: "thread", thread: { threadId: "thr_incomplete" } },',
      "});",
      'if (Result.isSuccess(malformedKnown)) throw new Error("malformed known entity degraded to unknown");',
      'if (malformedKnown.failure._tag !== "SymmetriaStreamItemMalformed") throw new Error(`malformed known entity produced ${String(malformedKnown.failure._tag)}`);',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("refuses an announced unsupported major on a delta through both public decode paths", () => {
    const script = [
      schemaPrelude,
      'import { SYMMETRIA_PROTOCOL_MAJOR, SymmetriaStreamItem, decodeSymmetriaStreamItem } from "@symmetria/broker-contract";',
      fixtureItemsScript,
      `const fixture = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.duplicate.json"))}, "utf8"));`,
      'const delta = fixtureItems(fixture).find((item) => item.type === "delta");',
      'if (delta === undefined) throw new Error("duplicate fixture contains no delta");',
      "const receivedMajor = SYMMETRIA_PROTOCOL_MAJOR + 1;",
      "const announced = { ...delta, protocolVersion: { major: receivedMajor, minor: 0 } };",
      "const schemaDecoded = Schema.decodeUnknownResult(SymmetriaStreamItem)(announced);",
      'if (Result.isSuccess(schemaDecoded)) throw new Error("root stream schema accepted a foreign-major delta");',
      "const gated = decodeSymmetriaStreamItem(announced);",
      'if (Result.isSuccess(gated)) throw new Error("typed decoder accepted a foreign-major delta");',
      'if (gated.failure._tag !== "SymmetriaProtocolVersionMismatch") throw new Error(`unexpected rejection ${String(gated.failure._tag)}`);',
      'if (gated.failure.supportedMajor !== SYMMETRIA_PROTOCOL_MAJOR || gated.failure.receivedMajor !== receivedMajor) throw new Error("delta rejection did not name both majors");',
      "const unannounced = Schema.decodeUnknownResult(SymmetriaStreamItem)(delta);",
      'if (Result.isFailure(unannounced)) throw new Error("delta without a repeated protocol version was refused");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("consumes a later draft delta without replacing a newer draft version", () => {
    const script = [
      schemaPrelude,
      'import { SymmetriaStreamItem, applySymmetriaStreamDelta, openSymmetriaStream } from "@symmetria/broker-contract";',
      `const snapshotInput = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.snapshot.golden.json"))}, "utf8"));`,
      "const snapshot = Schema.decodeUnknownSync(SymmetriaStreamItem)(snapshotInput);",
      'if (snapshot.type !== "snapshot") throw new Error("golden item is not a snapshot");',
      "const opened = openSymmetriaStream(snapshot);",
      "if (Result.isFailure(opened)) throw new Error(`golden snapshot did not open: ${opened.failure._tag}`);",
      "const held = opened.success.drafts[0];",
      'if (held === undefined || held.version === 0) throw new Error("golden snapshot cannot express a stale draft");',
      "let state = opened.success;",
      "for (const version of [held.version - 1, held.version]) {",
      "  const nonAdvancingDelta = Schema.decodeUnknownSync(SymmetriaStreamItem)({",
      '    type: "delta",',
      "    sequence: state.sequence + 1,",
      '    change: { entity: "draft", draft: { ...held, version, text: `non-advancing version ${version}` } },',
      "  });",
      '  if (nonAdvancingDelta.type !== "delta") throw new Error("non-advancing draft probe is not a delta");',
      "  const result = applySymmetriaStreamDelta(state, nonAdvancingDelta);",
      '  if (result.outcome !== "applied") throw new Error(`non-advancing draft position produced ${String(result.outcome)}`);',
      '  if (result.state.sequence !== state.sequence + 1) throw new Error("non-advancing draft position was not consumed");',
      '  if (JSON.stringify(result.state.drafts) !== JSON.stringify(opened.success.drafts)) throw new Error("non-advancing draft replaced the newer held draft");',
      "  state = result.state;",
      "}",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("refuses the unsupported-major fixture with both supported and received majors", () => {
    const script = [
      schemaPrelude,
      'import { SYMMETRIA_PROTOCOL_MAJOR, decodeSymmetriaStreamItem } from "@symmetria/broker-contract";',
      `const input = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.unsupportedMajor.json"))}, "utf8"));`,
      "const decoded = decodeSymmetriaStreamItem(input);",
      'if (Result.isSuccess(decoded)) throw new Error("unsupported protocol major decoded");',
      'if (decoded.failure._tag !== "SymmetriaProtocolVersionMismatch") throw new Error(`unexpected rejection ${String(decoded.failure._tag)}`);',
      'if (decoded.failure.supportedMajor !== SYMMETRIA_PROTOCOL_MAJOR) throw new Error("rejection did not report the supported major");',
      'if (decoded.failure.receivedMajor !== input.protocolVersion?.major) throw new Error("rejection did not report the received major");',
      'if (decoded.failure.receivedMajor === decoded.failure.supportedMajor) throw new Error("unsupported-major fixture announces the supported major");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("reports a repeated delta as a duplicate and applies it only once", () => {
    const script = [
      schemaPrelude,
      'import { SymmetriaStreamItem, applySymmetriaStreamDelta, openSymmetriaStream } from "@symmetria/broker-contract";',
      fixtureItemsScript,
      `const fixture = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.duplicate.json"))}, "utf8"));`,
      "const items = fixtureItems(fixture).map((item) => Schema.decodeUnknownSync(SymmetriaStreamItem)(item));",
      'if (items.length !== 3) throw new Error("duplicate fixture must contain a snapshot, a delta, and its replay");',
      'if (items[0].type !== "snapshot" || items[1].type !== "delta" || items[2].type !== "delta") throw new Error("duplicate fixture has the wrong item order");',
      'if (items[1].sequence !== items[2].sequence) throw new Error("duplicate fixture does not repeat one sequence");',
      "const opened = openSymmetriaStream(items[0]);",
      "if (Result.isFailure(opened)) throw new Error(`snapshot did not open: ${opened.failure._tag}`);",
      "const first = applySymmetriaStreamDelta(opened.success, items[1]);",
      'if (first.outcome !== "applied") throw new Error(`first delta produced ${String(first.outcome)}`);',
      "const replay = applySymmetriaStreamDelta(first.state, items[2]);",
      'if (replay.outcome !== "duplicate") throw new Error(`repeated delta produced ${String(replay.outcome)}`);',
      'if (JSON.stringify(replay.state) !== JSON.stringify(first.state)) throw new Error("duplicate changed stream state and was applied twice");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("reports a skipped sequence as a gap that requires a resnapshot", () => {
    const script = [
      schemaPrelude,
      'import { SymmetriaStreamItem, applySymmetriaStreamDelta, openSymmetriaStream } from "@symmetria/broker-contract";',
      fixtureItemsScript,
      `const fixture = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("stream.reordered.json"))}, "utf8"));`,
      "const items = fixtureItems(fixture).map((item) => Schema.decodeUnknownSync(SymmetriaStreamItem)(item));",
      'if (items.length !== 2) throw new Error("reordered fixture must contain a snapshot and one out-of-order delta");',
      'if (items[0].type !== "snapshot" || items[1].type !== "delta") throw new Error("reordered fixture has the wrong item order");',
      "const opened = openSymmetriaStream(items[0]);",
      "if (Result.isFailure(opened)) throw new Error(`snapshot did not open: ${opened.failure._tag}`);",
      "const gap = applySymmetriaStreamDelta(opened.success, items[1]);",
      'if (gap.outcome !== "gap") throw new Error(`skipped sequence produced ${String(gap.outcome)}`);',
      'if (gap.requiresResnapshot !== true) throw new Error("gap does not require a resnapshot");',
      'if (JSON.stringify(gap.state) !== JSON.stringify(opened.success)) throw new Error("gap was silently applied");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps the phase-five package tests collected and passing", () => {
    const result = run(vitePlusPath, ["test", "run", "--reporter=verbose"], contractPackageRoot);
    expectSuccessfulCommand(result);
    expect(commandOutput(result)).toContain("src/stream.test.ts");
  }, 30_000);

  it("keeps the phase-five package source green under tsc --noEmit", () => {
    expect(NodeFS.existsSync(NodePath.join(contractSourceRoot, "stream.ts"))).toBe(true);
    expectSuccessfulCommand(run(typecheckerPath, ["--noEmit"], contractPackageRoot));
  });
});
