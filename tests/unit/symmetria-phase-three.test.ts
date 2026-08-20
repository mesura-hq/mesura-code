// @effect-diagnostics nodeBuiltinImport:off - runs the package as an external consumer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const contractPackageRoot = NodePath.join(repositoryRoot, "packages/symmetria-broker-contract");
const contractSourceRoot = NodePath.join(contractPackageRoot, "src");
const contractFixtureRoot = NodePath.join(contractPackageRoot, "test/fixtures");
const vitePlusPath = NodePath.join(repositoryRoot, "node_modules/.bin/vp");
const tsgoPath = NodePath.join(repositoryRoot, "node_modules/.bin/tsgo");

const run = (command: string, args: ReadonlyArray<string>, cwd = repositoryRoot) =>
  NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });

const commandOutput = (result: NodeChildProcess.SpawnSyncReturns<string>) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;

const expectSuccessfulCommand = (result: NodeChildProcess.SpawnSyncReturns<string>) => {
  if (result.status !== 0) {
    throw new Error(`command exited with ${String(result.status)}\n${commandOutput(result)}`);
  }
};

const runContractScript = (source: string) =>
  run(process.execPath, ["--input-type=module", "--eval", source], contractPackageRoot);

const fixturePath = (name: string) => NodePath.join(contractFixtureRoot, name);

const commandEnvelopePrelude = [
  'import * as NodeFS from "node:fs";',
  'import * as Result from "effect/Result";',
  'import * as Schema from "effect/Schema";',
  'import { SymmetriaCommandEnvelope } from "@symmetria/broker-contract";',
].join("\n");

const commandReceiptPrelude = [
  'import * as NodeFS from "node:fs";',
  'import * as Schema from "effect/Schema";',
  'import { SymmetriaCommandReceipt } from "@symmetria/broker-contract";',
].join("\n");

// The phase-three implementation is present in the working tree. These guards
// load the package as an external consumer and pin each acceptance criterion.
// A missing module or export fails one guard while this file stays collectable.
describe("Symmetria broker contract phase-three acceptance guards", () => {
  it("round-trips the command golden fixture byte-identically", () => {
    const script = [
      commandEnvelopePrelude,
      `const source = NodeFS.readFileSync(${JSON.stringify(fixturePath("command.golden.json"))}, "utf8");`,
      "const decoded = Schema.decodeUnknownSync(SymmetriaCommandEnvelope)(JSON.parse(source));",
      "const encoded = Schema.encodeSync(SymmetriaCommandEnvelope)(decoded);",
      "const roundTrip = `${JSON.stringify(encoded, null, 2)}\\n`;",
      'if (roundTrip !== source) throw new Error("golden fixture changed during decode and encode");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("carries commandId, threadId, one tagged command type, and createdAt", () => {
    const script = [
      commandEnvelopePrelude,
      `const input = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("command.golden.json"))}, "utf8"));`,
      "const decoded = Schema.decodeUnknownSync(SymmetriaCommandEnvelope)(input);",
      'for (const key of ["commandId", "threadId", "createdAt"]) {',
      '  if (typeof decoded[key] !== "string" || decoded[key].length === 0) throw new Error(`${key} is missing from the envelope`);',
      "}",
      'if (typeof decoded.type !== "string" || decoded.type.length === 0) throw new Error("the envelope has no command type tag");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("admits exactly turn start, turn interrupt, draft set, and activate command tags", () => {
    const script = [
      commandEnvelopePrelude,
      "const document = Schema.toJsonSchemaDocument(SymmetriaCommandEnvelope);",
      "const tags = new Set();",
      "const visit = (value) => {",
      '  if (value === null || typeof value !== "object") return;',
      "  const properties = value.properties;",
      '  if (properties !== null && typeof properties === "object"',
      '    && Object.hasOwn(properties, "commandId")',
      '    && Object.hasOwn(properties, "threadId")',
      '    && Object.hasOwn(properties, "createdAt")) {',
      "    const typeSchema = properties.type;",
      '    if (typeSchema !== null && typeof typeSchema === "object" && Array.isArray(typeSchema.enum)) {',
      '      for (const tag of typeSchema.enum) if (typeof tag === "string") tags.add(tag);',
      "    }",
      "  }",
      "  for (const child of Object.values(value)) visit(child);",
      "};",
      "visit(document.schema);",
      "const actual = [...tags].sort();",
      "if (actual.length !== 4) throw new Error(`command tags were ${JSON.stringify(actual)}`);",
      "const expectedMeanings = [",
      '  ["turn start", /turn.*start|start.*turn/i],',
      '  ["turn interrupt", /turn.*interrupt|interrupt.*turn/i],',
      '  ["draft set", /draft.*set|set.*draft/i],',
      '  ["activate", /activate/i],',
      "];",
      "for (const [meaning, pattern] of expectedMeanings) {",
      "  if (actual.filter((tag) => pattern.test(tag)).length !== 1) throw new Error(`${meaning} does not name exactly one tag: ${JSON.stringify(actual)}`);",
      "}",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("decodes activate with a target surface present and with it absent", () => {
    const script = [
      commandEnvelopePrelude,
      `const fixture = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("command.activate.json"))}, "utf8"));`,
      "const input = fixture.envelope ?? fixture;",
      'if (typeof input.type !== "string" || !/activate/i.test(input.type)) throw new Error("activation fixture has the wrong command tag");',
      "const targetKey = Object.keys(input).find((key) => /target.*surface|surface.*target/i.test(key));",
      'if (targetKey === undefined) throw new Error("activation fixture has no target surface");',
      "const withTarget = Schema.decodeUnknownResult(SymmetriaCommandEnvelope)(input);",
      "if (Result.isFailure(withTarget)) throw new Error(`activation with target failed: ${withTarget.failure.message}`);",
      'if (!Object.hasOwn(withTarget.success, targetKey)) throw new Error("the decoder dropped the target surface");',
      "const withoutTargetInput = { ...input };",
      "delete withoutTargetInput[targetKey];",
      "const withoutTarget = Schema.decodeUnknownResult(SymmetriaCommandEnvelope)(withoutTargetInput);",
      "if (Result.isFailure(withoutTarget)) throw new Error(`activation without target failed: ${withoutTarget.failure.message}`);",
      'if (Object.hasOwn(withoutTarget.success, targetKey)) throw new Error("the absent target surface was synthesized");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps first-application and replay receipts equal except for their replay marker", () => {
    const script = [
      commandReceiptPrelude,
      `const fixture = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("command.duplicate.json"))}, "utf8"));`,
      "const candidates = Array.isArray(fixture) ? fixture : Array.isArray(fixture.receipts) ? fixture.receipts : [fixture.first, fixture.replay];",
      'if (candidates.length !== 2 || candidates.some((value) => value === undefined)) throw new Error("duplicate fixture must contain first and replay receipts");',
      "const receipts = candidates.map((value) => Schema.decodeUnknownSync(SymmetriaCommandReceipt)(value));",
      'if (receipts[0].commandId !== receipts[1].commandId) throw new Error("duplicate receipts do not share one commandId");',
      "const differences = [];",
      "const compare = (left, right, path = []) => {",
      '  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {',
      "    if (!Object.is(left, right)) differences.push({ path, left, right });",
      "    return;",
      "  }",
      "  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);",
      "  for (const key of keys) compare(left[key], right[key], [...path, key]);",
      "};",
      "compare(receipts[0], receipts[1]);",
      'if (differences.length !== 1) throw new Error(`receipts differ at ${differences.map((item) => item.path.join(".")).join(", ")}`);',
      'const markerPath = differences[0].path.join(".");',
      "if (!/replay|application|delivery|disposition/i.test(markerPath)) throw new Error(`the only difference is not a replay marker: ${markerPath}`);",
      'const leafEntries = (value, path = []) => value !== null && typeof value === "object"',
      "  ? Object.entries(value).flatMap(([key, child]) => leafEntries(child, [...path, key]))",
      "  : [{ path, value }];",
      'const effectEntries = leafEntries(receipts[0]).filter((entry) => /effect/i.test(entry.path.join(".")));',
      'if (effectEntries.length === 0 || effectEntries.every((entry) => entry.value === null || entry.value === undefined)) throw new Error("applied receipt has no effect identity");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("defines a refused receipt with a required typed rejection and no effect identity", () => {
    const script = [
      commandReceiptPrelude,
      "const document = Schema.toJsonSchemaDocument(SymmetriaCommandReceipt);",
      "const definitions = document.definitions ?? {};",
      "const resolve = (value) => {",
      '  if (value === null || typeof value !== "object" || typeof value.$ref !== "string") return value;',
      '  const prefix = "#/$defs/";',
      "  return value.$ref.startsWith(prefix) ? definitions[value.$ref.slice(prefix.length)] ?? value : value;",
      "};",
      "const objects = [];",
      "const visit = (input, seen = new Set()) => {",
      "  const value = resolve(input);",
      '  if (value === null || typeof value !== "object" || seen.has(value)) return;',
      "  seen.add(value);",
      '  if (value.type === "object" && value.properties) objects.push(value);',
      "  for (const child of Object.values(value)) visit(child, seen);",
      "};",
      "visit(document.schema);",
      "const literalValues = (value) => {",
      "  const resolved = resolve(value);",
      '  if (resolved === null || typeof resolved !== "object") return [];',
      "  const here = Array.isArray(resolved.enum) ? resolved.enum : [];",
      "  return [...here, ...Object.values(resolved).flatMap(literalValues)];",
      "};",
      'const refused = objects.find((object) => Object.values(object.properties).some((property) => literalValues(property).some((literal) => typeof literal === "string" && /refus|reject/i.test(literal))));',
      'if (refused === undefined) throw new Error("receipt union has no refused member");',
      "const propertyKeys = Object.keys(refused.properties);",
      "const rejectionKey = propertyKeys.find((key) => /rejection|reason/i.test(key));",
      'if (rejectionKey === undefined) throw new Error("refused receipt has no rejection reason");',
      'if (!Array.isArray(refused.required) || !refused.required.includes(rejectionKey)) throw new Error("rejection reason is optional");',
      "const rejectionObjects = [];",
      "const collectRejectionObjects = (input, seen = new Set()) => {",
      "  const value = resolve(input);",
      '  if (value === null || typeof value !== "object" || seen.has(value)) return;',
      "  seen.add(value);",
      '  if (value.type === "object" && value.properties) rejectionObjects.push(value);',
      "  for (const child of Object.values(value)) collectRejectionObjects(child, seen);",
      "};",
      "collectRejectionObjects(refused.properties[rejectionKey]);",
      'const hasTypedTag = rejectionObjects.some((object) => Object.entries(object.properties).some(([key, property]) => /^(?:_tag|type|code)$/.test(key) && literalValues(property).some((literal) => typeof literal === "string")));',
      'if (!hasTypedTag) throw new Error("rejection reason is not a tagged type");',
      'if (propertyKeys.some((key) => /effect/i.test(key))) throw new Error("refused receipt exposes an effect identity");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps non-empty text rules enforceable through emitted JSON Schema", () => {
    const script = [
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaCommandRejection, SymmetriaTurnStartCommand } from "@symmetria/broker-contract";',
      "const matchesType = (type, value) => {",
      '  if (type === "string") return typeof value === "string";',
      '  if (type === "null") return value === null;',
      '  if (type === "number") return typeof value === "number";',
      '  if (type === "integer") return Number.isInteger(value);',
      '  if (type === "boolean") return typeof value === "boolean";',
      '  if (type === "array") return Array.isArray(value);',
      '  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);',
      "  throw new Error(`unsupported JSON Schema type in regression validator: ${String(type)}`);",
      "};",
      "const accepts = (input, value, definitions) => {",
      "  if (input === true) return true;",
      "  if (input === false) return false;",
      '  if (input === null || typeof input !== "object") throw new Error("invalid JSON Schema node");',
      '  if (typeof input.$ref === "string") {',
      '    const prefix = "#/$defs/";',
      "    if (!input.$ref.startsWith(prefix)) throw new Error(`unsupported reference ${input.$ref}`);",
      "    const target = definitions[input.$ref.slice(prefix.length)];",
      "    if (target === undefined) throw new Error(`unresolved reference ${input.$ref}`);",
      "    return accepts(target, value, definitions);",
      "  }",
      "  const types = Array.isArray(input.type) ? input.type : input.type === undefined ? [] : [input.type];",
      "  if (types.length > 0 && !types.some((type) => matchesType(type, value))) return false;",
      '  if (Object.hasOwn(input, "const") && !Object.is(input.const, value)) return false;',
      "  if (Array.isArray(input.enum) && !input.enum.some((item) => Object.is(item, value))) return false;",
      '  if (typeof value === "string") {',
      "    if (Number.isInteger(input.minLength) && [...value].length < input.minLength) return false;",
      '    if (typeof input.pattern === "string" && !new RegExp(input.pattern, "u").test(value)) return false;',
      "  }",
      "  if (Array.isArray(input.allOf) && !input.allOf.every((item) => accepts(item, value, definitions))) return false;",
      "  if (Array.isArray(input.anyOf) && !input.anyOf.some((item) => accepts(item, value, definitions))) return false;",
      "  if (Array.isArray(input.oneOf) && input.oneOf.filter((item) => accepts(item, value, definitions)).length !== 1) return false;",
      "  if (input.not !== undefined && accepts(input.not, value, definitions)) return false;",
      "  return true;",
      "};",
      "const turnDocument = Schema.toJsonSchemaDocument(SymmetriaTurnStartCommand);",
      "const turnTextSchema = turnDocument.schema.properties.text;",
      "const rejectionDocument = Schema.toJsonSchemaDocument(SymmetriaCommandRejection);",
      "const rejectionDetailSchema = rejectionDocument.schema.properties.detail;",
      "const cases = [",
      '  ["turn text", turnTextSchema, turnDocument.definitions ?? {}, "send this turn"],',
      '  ["rejection detail", rejectionDetailSchema, rejectionDocument.definitions ?? {}, "surface is offline"],',
      "];",
      "for (const [label, schema, definitions, validText] of cases) {",
      '  for (const invalidText of ["", "   ", "\\t\\n"]) {',
      "    if (accepts(schema, invalidText, definitions)) throw new Error(`${label} JSON Schema accepted ${JSON.stringify(invalidText)}`);",
      "  }",
      "  if (!accepts(schema, validText, definitions)) throw new Error(`${label} JSON Schema refused non-empty text`);",
      "}",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("refuses an envelope that omits commandId", () => {
    const script = [
      commandEnvelopePrelude,
      `const input = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("command.golden.json"))}, "utf8"));`,
      "delete input.commandId;",
      "const result = Schema.decodeUnknownResult(SymmetriaCommandEnvelope)(input);",
      'if (Result.isSuccess(result)) throw new Error("envelope decoded without commandId");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps the phase-three package tests collected and passing", () => {
    const result = run(vitePlusPath, ["test", "run", "--reporter=verbose"], contractPackageRoot);
    expectSuccessfulCommand(result);
    const output = commandOutput(result);
    expect(output).toContain("src/command.test.ts");
  }, 30_000);

  it("keeps the phase-three package source green under tsgo --noEmit", () => {
    expect(NodeFS.existsSync(NodePath.join(contractSourceRoot, "command.ts"))).toBe(true);
    expectSuccessfulCommand(run(tsgoPath, ["--noEmit"], contractPackageRoot));
  });
});
