// @effect-diagnostics nodeBuiltinImport:off - the drift test reads the emitted
// artifacts off disk, which is the whole point of it.
import * as NodeFS from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Barrel from "./index.ts";
import {
  buildSymmetriaJsonSchemaArtifacts,
  buildSymmetriaSchemaArtifactSet,
  buildSymmetriaSchemaIndex,
  SYMMETRIA_JSON_SCHEMA_DIALECT,
  SYMMETRIA_SCHEMA_ROOTS,
  SYMMETRIA_UNPUBLISHED_SCHEMAS,
} from "./jsonSchema.ts";
import { SYMMETRIA_CONTRACT_VERSION } from "./version.ts";

const readArtifact = (file: string): string =>
  NodeFS.readFileSync(new URL(`../schema/${file}`, import.meta.url), "utf8");

const emittedFileNames = (): ReadonlyArray<string> =>
  NodeFS.readdirSync(new URL("../schema/", import.meta.url))
    .filter((name) => name.endsWith(".json"))
    .sort();

type JsonObject = Readonly<Record<string, unknown>>;

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

const resolveJsonPointer = (document: unknown, reference: string): unknown => {
  if (reference === "#") return document;
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) => {
      if (value === null || typeof value !== "object") return undefined;
      return (value as JsonObject)[part];
    }, document);
};

const isObjectSchema = (object: JsonObject) =>
  object.type === "object" || object.properties !== undefined;

describe("Symmetria JSON Schema artifacts", () => {
  it("has one document on disk for every root, and nothing else", () => {
    expect(emittedFileNames()).toEqual(
      [...SYMMETRIA_SCHEMA_ROOTS.map((root) => root.file), "index.json"].sort(),
    );
  });

  // The drift guard: someone edits a schema in `src/` and forgets to run the
  // generator, and this is what tells them. It rebuilds every artifact in
  // memory and compares it byte for byte against the checked-in file.
  it("matches the checked-in artifacts byte for byte", () => {
    for (const artifact of buildSymmetriaSchemaArtifactSet()) {
      expect(readArtifact(artifact.file), `${artifact.file} is stale`).toBe(artifact.source);
    }
  });

  it("declares draft 2020-12 on every document", () => {
    for (const artifact of buildSymmetriaJsonSchemaArtifacts()) {
      expect(artifact.document.$schema, artifact.file).toBe(SYMMETRIA_JSON_SCHEMA_DIALECT);
    }
  });

  // Self-containment is what makes a document publishable on its own: a QML
  // consumer validating one payload must not have to fetch a second file.
  it("resolves every reference inside the document that makes it", () => {
    let referenceCount = 0;
    for (const artifact of buildSymmetriaJsonSchemaArtifacts()) {
      walkJson(artifact.document, (object) => {
        if (typeof object.$ref !== "string") return;
        referenceCount += 1;
        expect(object.$ref, `${artifact.file} points outside itself`).toMatch(/^#(?:\/|$)/);
        expect(
          resolveJsonPointer(artifact.document, object.$ref),
          `${artifact.file} cannot resolve ${object.$ref}`,
        ).toBeDefined();
      });
    }
    expect(referenceCount).toBeGreaterThan(0);
  });

  // Not a looseness bug. A consumer has to ignore an additive unknown field,
  // and the TypeScript decoder already drops one at every depth; a closed
  // schema here would make a QML consumer reject what TypeScript accepts.
  it("leaves every object schema open at every depth", () => {
    let objectSchemaCount = 0;
    for (const artifact of buildSymmetriaJsonSchemaArtifacts()) {
      walkJson(artifact.document, (object) => {
        if (!isObjectSchema(object)) return;
        objectSchemaCount += 1;
        expect(object.additionalProperties, `${artifact.file} closed an object schema`).toBe(true);
      });
    }
    expect(objectSchemaCount).toBeGreaterThan(0);
  });

  it("indexes every document with the contract version", () => {
    const artifacts = buildSymmetriaJsonSchemaArtifacts();
    const index = buildSymmetriaSchemaIndex(artifacts);
    expect(index.contractVersion).toBe(SYMMETRIA_CONTRACT_VERSION);
    expect(index.schemas.map((entry) => entry.file)).toEqual(
      artifacts.map((artifact) => artifact.file),
    );
    for (const entry of index.schemas) expect(entry.summary.length).toBeGreaterThan(0);
  });

  it("emits the same bytes on every build", () => {
    expect(buildSymmetriaSchemaArtifactSet()).toEqual(buildSymmetriaSchemaArtifactSet());
  });

  // The root list is written by hand, so this is what stops a wire schema added
  // by a later run from shipping with no document, no index entry and no
  // movement in the checksum a consumer pins. Asserted against the exported
  // surface, the way the package asserts its privacy allowlists.
  it("covers every exported schema by a root, a root's tree, or a named exclusion", () => {
    const reachable = new WeakSet<object>();
    const walk = (value: unknown, seen: Set<object>): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      reachable.add(value);
      for (const child of Object.values(value)) walk(child, seen);
    };
    for (const root of SYMMETRIA_SCHEMA_ROOTS) walk(root.schema.ast, new Set());

    const uncovered = Object.entries(Barrel)
      .filter(([, value]) => Schema.isSchema(value))
      .filter(([, value]) => !reachable.has((value as Schema.Top).ast))
      .map(([name]) => name)
      .sort();

    expect(uncovered).toEqual([...SYMMETRIA_UNPUBLISHED_SCHEMAS].sort());
  });

  // An exclusion that names something the package no longer exports is a stale
  // exemption, and a stale exemption hides the next addition.
  it("keeps every named exclusion a schema the package still exports", () => {
    for (const name of SYMMETRIA_UNPUBLISHED_SCHEMAS) {
      expect(Schema.isSchema((Barrel as Record<string, unknown>)[name]), name).toBe(true);
    }
  });
});
