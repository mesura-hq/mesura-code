// @effect-diagnostics nodeBuiltinImport:off - drives generated artifacts and package tools.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  commandOutput,
  contractPackageRoot,
  expectSuccessfulCommand,
  run,
  runContractScript,
  tsgoPath,
  vitePlusPath,
} from "./contractHarness.ts";

const schemaDirectory = NodePath.join(contractPackageRoot, "schema");
const schemaIndexPath = NodePath.join(schemaDirectory, "index.json");

type JsonObject = Readonly<Record<string, unknown>>;

type SchemaIndex = {
  readonly contractVersion?: unknown;
  readonly checksum?: unknown;
  readonly sourceChecksum?: unknown;
  readonly schemas?: unknown;
};

const readJsonObject = (path: string): JsonObject => {
  const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return value as JsonObject;
};

const readSchemaIndex = (): SchemaIndex => readJsonObject(schemaIndexPath);

const schemaDocumentPaths = (root = schemaDirectory): ReadonlyArray<string> =>
  NodeFS.existsSync(root)
    ? NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
        )
        .map((entry) => NodePath.join(entry.parentPath, entry.name))
        .sort()
    : [];

const snapshotSchemaDirectory = (root = schemaDirectory): Readonly<Record<string, string>> =>
  Object.fromEntries(
    NodeFS.existsSync(root)
      ? NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry): readonly [string, string] => {
            const path = NodePath.join(entry.parentPath, entry.name);
            return [NodePath.relative(root, path), NodeFS.readFileSync(path, "utf8")];
          })
          .sort(([left], [right]) => left.localeCompare(right))
      : [],
  );

const copyContractPackageToTemporaryDirectory = (prefix: string) => {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  const temporaryPackageRoot = NodePath.join(temporaryRoot, "symmetria-broker-contract");
  NodeFS.cpSync(contractPackageRoot, temporaryPackageRoot, {
    recursive: true,
    filter: (source) => !["node_modules", ".vite-plus"].includes(NodePath.basename(source)),
  });
  NodeFS.symlinkSync(
    NodePath.join(contractPackageRoot, "node_modules"),
    NodePath.join(temporaryPackageRoot, "node_modules"),
    "dir",
  );
  return { temporaryPackageRoot, temporaryRoot };
};

const collectJsonStrings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectJsonStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectJsonStrings);
  }
  return [];
};

const resolveJsonPointer = (document: unknown, reference: string): unknown => {
  if (reference === "#") return document;
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) => {
      if (value === null || typeof value !== "object") return undefined;
      return (value as Readonly<Record<string, unknown>>)[part];
    }, document);
};

const walkJson = (value: unknown, visit: (object: JsonObject) => void): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  const object = value as JsonObject;
  visit(object);
  for (const child of Object.values(object)) walkJson(child, visit);
};

const calculateContractChecksum = (
  root = schemaDirectory,
  documentPaths = schemaDocumentPaths(root),
): string => {
  const hash = NodeCrypto.createHash("sha256");
  for (const path of documentPaths) {
    const relativePath = NodePath.relative(root, path).split(NodePath.sep).join("/");
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(NodeFS.readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

// Each guard stays collectable if a phase-six script, artifact, or export is
// removed. One regression therefore fails without hiding the remaining checks.
describe("Symmetria broker contract phase-six guards", () => {
  it("regenerates every schema artifact byte-identically on two consecutive runs", () => {
    expect(NodeFS.existsSync(schemaIndexPath)).toBe(true);
    const { temporaryPackageRoot, temporaryRoot } = copyContractPackageToTemporaryDirectory(
      "symmetria-schema-generation-",
    );
    const temporarySchemaDirectory = NodePath.join(temporaryPackageRoot, "schema");

    try {
      const before = snapshotSchemaDirectory(temporarySchemaDirectory);
      expect(Object.keys(before).length).toBeGreaterThan(1);

      expectSuccessfulCommand(run(vitePlusPath, ["run", "generate"], temporaryPackageRoot));
      const afterFirstGeneration = snapshotSchemaDirectory(temporarySchemaDirectory);
      expect(afterFirstGeneration).toEqual(before);

      expectSuccessfulCommand(run(vitePlusPath, ["run", "generate"], temporaryPackageRoot));
      expect(snapshotSchemaDirectory(temporarySchemaDirectory)).toEqual(afterFirstGeneration);
    } finally {
      NodeFS.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it("emits one self-contained draft 2020-12 document for every root schema", () => {
    const documentPaths = schemaDocumentPaths();
    expect(documentPaths.length).toBeGreaterThan(0);

    for (const path of documentPaths) {
      const document = readJsonObject(path);
      expect(document.$schema, path).toBe("https://json-schema.org/draft/2020-12/schema");
      walkJson(document, (object) => {
        if (typeof object.$ref !== "string") return;
        expect(object.$ref, `${path} contains an external reference`).toMatch(/^#(?:\/|$)/);
        expect(
          resolveJsonPointer(document, object.$ref),
          `${path} cannot resolve ${object.$ref}`,
        ).toBeDefined();
      });
    }

    const script = [
      'import * as NodeFS from "node:fs";',
      'import * as Schema from "effect/Schema";',
      'import { SymmetriaCommandEnvelope, SymmetriaCommandReceipt, SymmetriaDraft, SymmetriaDraftUpdate, SymmetriaDraftUpdateResult, SymmetriaStreamItem, SymmetriaSurfacePresence, SymmetriaThreadSummary } from "@symmetria/broker-contract";',
      `const paths = ${JSON.stringify(documentPaths)};`,
      "const roots = { SymmetriaThreadSummary, SymmetriaSurfacePresence, SymmetriaCommandEnvelope, SymmetriaCommandReceipt, SymmetriaDraft, SymmetriaDraftUpdate, SymmetriaDraftUpdateResult, SymmetriaStreamItem };",
      "const canonical = (value) => {",
      "  if (Array.isArray(value)) return value.map(canonical);",
      '  if (value === null || typeof value !== "object") return value;',
      "  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));",
      "};",
      "const withOpenObjects = (value) => {",
      "  if (Array.isArray(value)) return value.map(withOpenObjects);",
      '  if (value === null || typeof value !== "object") return value;',
      "  const output = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withOpenObjects(child)]));",
      '  if (output.type === "object" || output.properties !== undefined) output.additionalProperties = true;',
      "  return output;",
      "};",
      "const withoutDocumentMetadata = (document) => {",
      "  const { $schema, $id, $comment, title, ...schema } = document;",
      "  void $schema; void $id; void $comment; void title;",
      "  return schema;",
      "};",
      "const actual = paths.map((path) => canonical(withoutDocumentMetadata(JSON.parse(NodeFS.readFileSync(path, 'utf8')))));",
      "const remaining = new Set(actual.map((_, index) => index));",
      "for (const [name, root] of Object.entries(roots)) {",
      "  const generated = Schema.toJsonSchemaDocument(root);",
      "  const expected = withOpenObjects({ ...generated.schema, ...(generated.definitions && Object.keys(generated.definitions).length > 0 ? { $defs: generated.definitions } : {}) });",
      "  const expectedSource = JSON.stringify(canonical(expected));",
      "  const match = [...remaining].find((index) => JSON.stringify(actual[index]) === expectedSource);",
      "  if (match === undefined) throw new Error(`no emitted document projects ${name}`);",
      "  remaining.delete(match);",
      "}",
      "if (remaining.size !== 0) throw new Error(`${remaining.size} emitted document(s) do not project a root schema`);",
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("sets additionalProperties to true on every emitted object schema at every depth", () => {
    const documentPaths = schemaDocumentPaths();
    expect(documentPaths.length).toBeGreaterThan(0);
    let objectSchemaCount = 0;

    for (const path of documentPaths) {
      walkJson(readJsonObject(path), (object) => {
        if (object.type !== "object" && object.properties === undefined) return;
        objectSchemaCount += 1;
        expect(object.additionalProperties, `${path} contains a closed object schema`).toBe(true);
      });
    }

    expect(objectSchemaCount).toBeGreaterThan(0);
  });

  it("indexes every emitted document with the contract version and checksum", () => {
    expect(NodeFS.existsSync(schemaIndexPath)).toBe(true);
    const index = readSchemaIndex();
    expect(index.contractVersion).toBe("1.0.0");
    expect(index.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(index.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);

    const emittedFiles = schemaDocumentPaths().map((path) =>
      NodePath.relative(schemaDirectory, path).split(NodePath.sep).join("/"),
    );
    const indexedFiles = collectJsonStrings(index.schemas)
      .filter((value) => value.endsWith(".json") && value !== "index.json")
      .map((value) => value.replace(/^\.\//, ""))
      .sort();
    expect(indexedFiles).toEqual(emittedFiles);
  });

  it("recomputes the recorded checksum from the exact emitted document bytes", () => {
    expect(NodeFS.existsSync(schemaIndexPath)).toBe(true);
    const index = readSchemaIndex();
    const documentPaths = schemaDocumentPaths();
    expect(documentPaths.length).toBeGreaterThan(0);
    expect(index.checksum).toBe(calculateContractChecksum(schemaDirectory, documentPaths));
  });

  it("changes the checksum after a Symmetria root schema changes and regeneration runs", () => {
    expect(
      NodeFS.existsSync(NodePath.join(contractPackageRoot, "scripts/emit-json-schema.ts")),
    ).toBe(true);
    const { temporaryPackageRoot, temporaryRoot } = copyContractPackageToTemporaryDirectory(
      "symmetria-schema-checksum-",
    );

    try {
      const generatorPath = NodePath.join(temporaryPackageRoot, "scripts/emit-json-schema.ts");
      expectSuccessfulCommand(run(process.execPath, [generatorPath], temporaryPackageRoot));
      const baselineIndex = readJsonObject(
        NodePath.join(temporaryPackageRoot, "schema/index.json"),
      );

      const threadSummaryPath = NodePath.join(temporaryPackageRoot, "src/threadSummary.ts");
      const source = NodeFS.readFileSync(threadSummaryPath, "utf8");
      const declaration = "export const SymmetriaThreadSummary = Schema.Struct({";
      expect(source).toContain(declaration);
      NodeFS.writeFileSync(
        threadSummaryPath,
        source.replace(
          declaration,
          `${declaration}\n  checksumSensitivityProbe: Schema.optionalKey(Schema.String),`,
        ),
      );

      expectSuccessfulCommand(run(process.execPath, [generatorPath], temporaryPackageRoot));
      const changedIndex = readJsonObject(NodePath.join(temporaryPackageRoot, "schema/index.json"));
      expect(changedIndex.checksum).not.toBe(baselineIndex.checksum);
    } finally {
      NodeFS.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it("changes the source checksum when JSON Schema cannot express a schema change", () => {
    const { temporaryPackageRoot, temporaryRoot } = copyContractPackageToTemporaryDirectory(
      "symmetria-source-checksum-",
    );

    try {
      const generatorPath = NodePath.join(temporaryPackageRoot, "scripts/emit-json-schema.ts");
      expectSuccessfulCommand(run(process.execPath, [generatorPath], temporaryPackageRoot));
      const baselineIndex = readJsonObject(
        NodePath.join(temporaryPackageRoot, "schema/index.json"),
      );

      const threadSummaryPath = NodePath.join(temporaryPackageRoot, "src/threadSummary.ts");
      const source = NodeFS.readFileSync(threadSummaryPath, "utf8");
      const checkedTitle = "  title: TrimmedNonEmptyString,";
      expect(source).toContain(checkedTitle);
      NodeFS.writeFileSync(
        threadSummaryPath,
        source.replace(checkedTitle, "  title: Schema.String,"),
      );

      expectSuccessfulCommand(run(process.execPath, [generatorPath], temporaryPackageRoot));
      const changedIndex = readJsonObject(NodePath.join(temporaryPackageRoot, "schema/index.json"));
      expect(baselineIndex.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(changedIndex.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(changedIndex.sourceChecksum).not.toBe(baselineIndex.sourceChecksum);
    } finally {
      NodeFS.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it("uses stable names for shared definitions instead of positional suffixes", () => {
    const streamDocument = readJsonObject(NodePath.join(schemaDirectory, "streamItem.schema.json"));
    const definitions = streamDocument.$defs;
    expect(definitions).not.toBeNull();
    expect(typeof definitions).toBe("object");
    expect(Array.isArray(definitions)).toBe(false);

    const definitionNames = Object.keys(definitions as JsonObject);
    const references = collectJsonStrings(streamDocument)
      .filter((value) => value.startsWith("#/$defs/"))
      .map((value) => value.slice("#/$defs/".length));
    for (const sharedName of [
      "SymmetriaDraft",
      "SymmetriaSurfacePresence",
      "SymmetriaThreadSummary",
    ]) {
      expect(definitionNames, `${sharedName} has no stable definition`).toContain(sharedName);
      expect(references, `${sharedName} is not referenced by its stable name`).toContain(
        sharedName,
      );
    }
    expect(definitionNames.filter((name) => /^Objects_\d+$/.test(name))).toEqual([]);
  });

  it("keeps Node-only schema tools out of the runtime package barrel", () => {
    const script = [
      'import * as RuntimeContract from "@symmetria/broker-contract";',
      'import * as ChecksumTools from "@symmetria/broker-contract/checksum";',
      'import * as JsonSchemaTools from "@symmetria/broker-contract/jsonSchema";',
      "const forbiddenRuntimeExports = [",
      '  "computeSymmetriaContractChecksum",',
      '  "computeSymmetriaSourceChecksum",',
      '  "buildSymmetriaJsonSchemaArtifacts",',
      '  "buildSymmetriaSchemaArtifactSet",',
      "];",
      "for (const name of forbiddenRuntimeExports) {",
      "  if (name in RuntimeContract) throw new Error(`${name} leaked into the runtime barrel`);",
      "}",
      'if (typeof ChecksumTools.computeSymmetriaContractChecksum !== "function") throw new Error("checksum subpath is unavailable");',
      'if (typeof JsonSchemaTools.buildSymmetriaJsonSchemaArtifacts !== "function") throw new Error("JSON Schema subpath is unavailable");',
    ].join("\n");

    expectSuccessfulCommand(runContractScript(script));
  });

  it("documents that schema artifacts are generated and must not be hand-edited", () => {
    const readmePath = NodePath.join(contractPackageRoot, "README.md");
    expect(NodeFS.existsSync(readmePath)).toBe(true);
    const readme = NodeFS.readFileSync(readmePath, "utf8");
    expect(readme).toMatch(/schema\/.*generated|generated.*schema\//is);
    expect(readme).toMatch(/do not hand[- ]edit|never hand[- ]edit/is);
    expect(readme).toContain("vp run generate");
  });

  it("keeps the phase-six package suite and typecheck green", () => {
    const testResult = run(
      vitePlusPath,
      ["test", "run", "--reporter=verbose"],
      contractPackageRoot,
    );
    expectSuccessfulCommand(testResult);
    const output = commandOutput(testResult);
    expect(output).toContain("src/jsonSchema.test.ts");
    expect(output).toContain("src/checksum.test.ts");
    expectSuccessfulCommand(run(tsgoPath, ["--noEmit"], contractPackageRoot));
  }, 30_000);
});
