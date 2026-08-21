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

const goldenRoundTripScript = (options: {
  readonly exportName: string;
  readonly modulePath: string;
  readonly fixtureName: string;
}) =>
  [
    'import * as NodeFS from "node:fs";',
    'import * as Schema from "effect/Schema";',
    `import { ${options.exportName} } from ${JSON.stringify(options.modulePath)};`,
    `const source = NodeFS.readFileSync(${JSON.stringify(fixturePath(options.fixtureName))}, "utf8");`,
    "const input = JSON.parse(source);",
    `const decoded = Schema.decodeUnknownSync(${options.exportName})(input);`,
    `const encoded = Schema.encodeSync(${options.exportName})(decoded);`,
    "const roundTrip = `${JSON.stringify(encoded, null, 2)}\\n`;",
    'if (roundTrip !== source) throw new Error("golden fixture changed during decode and encode");',
  ].join("\n");

// Every check in this file is a pre-implementation specification. Each check
// loads the future module inside a child process, so a missing module is a test
// failure while this test file still imports and every specification runs.
describe("Symmetria broker contract phase-two specifications", () => {
  it("round-trips the thread summary golden fixture byte-identically", () => {
    expectSuccessfulCommand(
      runContractScript(
        goldenRoundTripScript({
          exportName: "SymmetriaThreadSummary",
          modulePath: "@symmetria/broker-contract",
          fixtureName: "threadSummary.golden.json",
        }),
      ),
    );
  });

  it("addresses a thread by threadId and projectId without a process, pane, or slot key", () => {
    const script = [
      'import * as NodeFS from "node:fs";',
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaThreadSummary } from "@symmetria/broker-contract";',
      `const input = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("threadSummary.golden.json"))}, "utf8"));`,
      "const decoded = Schema.decodeUnknownSync(SymmetriaThreadSummary)(input);",
      'if (typeof decoded.threadId !== "string" || decoded.threadId !== input.threadId) throw new Error("threadId is not the thread address");',
      'if (typeof decoded.projectId !== "string" || decoded.projectId !== input.projectId) throw new Error("projectId is not the project address");',
      "const forbidden = [];",
      'const visit = (value, path = "") => {',
      '  if (value === null || typeof value !== "object") return;',
      "  for (const [key, child] of Object.entries(value)) {",
      "    const normalized = key.toLowerCase();",
      '    if (normalized.includes("processid") || normalized.includes("pane") || normalized.includes("slot")) forbidden.push(path ? `${path}.${key}` : key);',
      "    visit(child, path ? `${path}.${key}` : key);",
      "  }",
      "};",
      "visit(decoded);",
      'if (forbidden.length > 0) throw new Error(`ephemeral addresses leaked: ${forbidden.join(", ")}`);',
    ].join("\n");
    expectSuccessfulCommand(runContractScript(script));
  });

  it("drops provider payload, transcript, and project configuration fields", () => {
    const script = [
      'import * as NodeFS from "node:fs";',
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaThreadSummary } from "@symmetria/broker-contract";',
      `const golden = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("threadSummary.golden.json"))}, "utf8"));`,
      "const input = {",
      "  ...golden,",
      '  providerPayload: { secret: "provider-native" },',
      '  transcript: [{ role: "user", text: "private message" }],',
      '  projectConfiguration: { environment: { API_TOKEN: "secret" } },',
      "};",
      "const decoded = Schema.decodeUnknownSync(SymmetriaThreadSummary)(input);",
      'for (const key of ["providerPayload", "transcript", "projectConfiguration"]) {',
      "  if (Object.prototype.hasOwnProperty.call(decoded, key)) throw new Error(`${key} crossed the allowlist`);",
      "}",
    ].join("\n");
    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps transcript handles and private upstream fields out in both codec directions", () => {
    const script = [
      'import * as NodeFS from "node:fs";',
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaThreadSummary } from "@symmetria/broker-contract/threadSummary";',
      `const golden = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("threadSummary.golden.json"))}, "utf8"));`,
      "const privateKeys = [",
      '  "messages", "activities", "payload", "proposedPlans", "checkpoints",',
      '  "providerName", "providerInstanceId", "lastError", "workspaceRoot", "scripts",',
      '  "sourceProposedPlan", "assistantMessageId",',
      "];",
      "const privateFields = Object.fromEntries(privateKeys.map((key) => [key, `private-${key}`]));",
      "const input = {",
      "  ...golden,",
      "  ...privateFields,",
      "  latestTurn: { ...golden.latestTurn, ...privateFields },",
      "  session: { ...golden.session, ...privateFields },",
      "};",
      "const decoded = Schema.decodeUnknownSync(SymmetriaThreadSummary)(input);",
      "const encoded = Schema.encodeSync(SymmetriaThreadSummary)(input);",
      'const collectKeys = (value) => value !== null && typeof value === "object"',
      "  ? Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)])",
      "  : [];",
      'for (const [direction, value] of [["decode", decoded], ["encode", encoded]]) {',
      "  const keys = collectKeys(value);",
      "  for (const key of privateKeys) {",
      "    if (keys.includes(key)) throw new Error(`${direction} leaked ${key}`);",
      "  }",
      "}",
    ].join("\n");
    expectSuccessfulCommand(runContractScript(script));
  });

  it("round-trips the surface presence golden fixture byte-identically", () => {
    expectSuccessfulCommand(
      runContractScript(
        goldenRoundTripScript({
          exportName: "SymmetriaSurfacePresence",
          modulePath: "@symmetria/broker-contract",
          fixtureName: "surfacePresence.golden.json",
        }),
      ),
    );
  });

  it("maps a future surface kind to unknown instead of rejecting it", () => {
    const script = [
      'import * as NodeFS from "node:fs";',
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaSurfacePresence } from "@symmetria/broker-contract";',
      `const golden = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("surfacePresence.golden.json"))}, "utf8"));`,
      'const kindKey = ["surfaceKind", "clientKind", "kind"].find((key) => Object.prototype.hasOwnProperty.call(golden, key));',
      'if (kindKey === undefined) throw new Error("golden fixture has no surface kind field");',
      'const decoded = Schema.decodeUnknownSync(SymmetriaSurfacePresence)({ ...golden, [kindKey]: "future-surface-kind" });',
      'if (decoded[kindKey] !== "unknown") throw new Error(`future surface kind decoded as ${String(decoded[kindKey])}`);',
    ].join("\n");
    expectSuccessfulCommand(runContractScript(script));
  });

  it("requires the nullable thread summary field to be named worktreePath", () => {
    const script = [
      'import * as NodeFS from "node:fs";',
      'import * as Result from "effect/Result";',
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaThreadSummary } from "@symmetria/broker-contract";',
      `const golden = JSON.parse(NodeFS.readFileSync(${JSON.stringify(fixturePath("threadSummary.golden.json"))}, "utf8"));`,
      "const decode = Schema.decodeUnknownResult(SymmetriaThreadSummary);",
      "const nullable = decode({ ...golden, worktreePath: null });",
      'if (Result.isFailure(nullable)) throw new Error("worktreePath rejected null");',
      'if (!Object.prototype.hasOwnProperty.call(nullable.success, "worktreePath") || nullable.success.worktreePath !== null) throw new Error("worktreePath did not preserve null");',
      "const renamed = { ...golden, worktree: golden.worktreePath };",
      "delete renamed.worktreePath;",
      "const missingCanonicalName = decode(renamed);",
      'if (Result.isSuccess(missingCanonicalName)) throw new Error("worktreePath is optional or accepts a renamed field");',
    ].join("\n");
    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps the phase-two package tests collected and passing", () => {
    const result = run(vitePlusPath, ["test", "run", "--reporter=verbose"], contractPackageRoot);
    expectSuccessfulCommand(result);
    const output = commandOutput(result);
    expect(output).toContain("src/threadSummary.test.ts");
    expect(output).toContain("src/surfacePresence.test.ts");
  }, 30_000);

  it("keeps the phase-two package source green under tsgo --noEmit", () => {
    expect(NodeFS.existsSync(NodePath.join(contractSourceRoot, "threadSummary.ts"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(contractSourceRoot, "surfacePresence.ts"))).toBe(true);
    expectSuccessfulCommand(run(tsgoPath, ["--noEmit"], contractPackageRoot));
  });

  it("keeps each phase-two projection available through its public package subpath", () => {
    const script = [
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaThreadSummary } from "@symmetria/broker-contract/threadSummary";',
      'import { SymmetriaSurfacePresence } from "@symmetria/broker-contract/surfacePresence";',
      'if (!Schema.isSchema(SymmetriaThreadSummary)) throw new Error("threadSummary subpath did not export its schema");',
      'if (!Schema.isSchema(SymmetriaSurfacePresence)) throw new Error("surfacePresence subpath did not export its schema");',
    ].join("\n");
    expectSuccessfulCommand(runContractScript(script));
  });

  it("keeps byte-pinned fixtures safe under the package formatter check", () => {
    expectSuccessfulCommand(run(vitePlusPath, ["fmt", "--check"], contractPackageRoot));
  });
});
