// @effect-diagnostics nodeBuiltinImport:off - these assertions read the emitted
// artifacts off disk, because the artifact is the thing under test. Same
// exemption, and same reason, as `jsonSchema.test.ts`.
import * as NodeFS from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildSymmetriaJsonSchemaArtifacts } from "./jsonSchema.ts";
import { SymmetriaThreadSummary } from "./threadSummary.ts";

/**
 * Effect drops a check applied after a transformation, as in `TrimmedNonEmptyString`, from the
 * emitted JSON Schema. These assertions pin the emitted constraint and the decoder to the same
 * values. The last block pins the opposite on purpose: `IsoDateTime` has no check upstream, so
 * a bare timestamp string is faithful, and a constraint would refuse threads upstream accepts.
 */

type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Judges the document the CURRENT sources emit, not the committed `schema/` copy: reading only
 * the committed copy passes whenever it is stale. Whole-artifact freshness is
 * `jsonSchema.test.ts`'s job; the committed-artifact test below covers these fields only.
 */
const threadSummaryDocument = (): JsonObject => {
  const artifact = buildSymmetriaJsonSchemaArtifacts().find(
    (candidate) => candidate.file === "threadSummary.schema.json",
  );
  if (artifact === undefined) throw new Error("no emitted artifact for threadSummary");
  return artifact.document as unknown as JsonObject;
};

const committedThreadSummaryDocument = (): JsonObject =>
  JSON.parse(
    NodeFS.readFileSync(new URL("../schema/threadSummary.schema.json", import.meta.url), "utf8"),
  ) as JsonObject;

/**
 * The emitted schema node for one property of `SymmetriaThreadSummary`.
 *
 * A nullable field emits as `anyOf: [<the string>, {"type":"null"}]`, so the
 * string member is unwrapped here rather than at each call site — a caller
 * asking about `branch` wants the same answer it gets about `title`.
 */
const stringSchemaIn = (document: JsonObject, property: string): JsonObject => {
  const defs = (document["$defs"] ?? {}) as Record<string, JsonObject>;
  const summary = defs["SymmetriaThreadSummary"] ?? document;
  const properties = (summary["properties"] ?? {}) as Record<string, JsonObject>;
  const node = properties[property];
  if (node === undefined) throw new Error(`no emitted schema for property ${property}`);
  const anyOf = node["anyOf"];
  if (!Array.isArray(anyOf)) return node;
  const stringMember = anyOf.find(
    (member): member is JsonObject =>
      typeof member === "object" && member !== null && (member as JsonObject)["type"] === "string",
  );
  if (stringMember === undefined) throw new Error(`no string member in ${property}'s anyOf`);
  return stringMember;
};

/** The emitted schema for a property, derived live from the current sources. */
const stringSchemaFor = (property: string): JsonObject =>
  stringSchemaIn(threadSummaryDocument(), property);

/**
 * Collects `minLength` and `pattern`, including those Effect nests inside `allOf`. Not a JSON
 * Schema validator on purpose: a validator dependency in the root manifest costs a weekly
 * upstream conflict surface for two keywords.
 */
const stringConstraints = (node: JsonObject): { minLength?: number; pattern?: string } => {
  const collected: { minLength?: number; pattern?: string } = {};
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const object = value as JsonObject;
    if (typeof object["minLength"] === "number") collected.minLength = object["minLength"];
    if (typeof object["pattern"] === "string") collected.pattern = object["pattern"];
    visit(object["allOf"]);
  };
  visit(node);
  return collected;
};

/** Whether the emitted constraints on a node refuse a candidate string. */
const emittedSchemaRefuses = (node: JsonObject, candidate: string): boolean => {
  const { minLength, pattern } = stringConstraints(node);
  if (minLength !== undefined && candidate.length < minLength) return true;
  if (pattern !== undefined && !new RegExp(pattern).test(candidate)) return true;
  return false;
};

// Hoisted per the repository's `no-inline-schema-compile` rule: the compiled
// decoder is rebuilt on every call when it is constructed inline.
const decodeThreadSummary = Schema.decodeUnknownExit(SymmetriaThreadSummary);

const decoderRefuses = (title: string): boolean => {
  const candidate = {
    threadId: "thr_1",
    projectId: "prj_1",
    title,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    session: null,
    tokenUsage: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    deletedAt: null,
  };
  const result = decodeThreadSummary(candidate);
  return result._tag === "Failure";
};

const FREE_TEXT_PROPERTIES = ["title", "branch", "worktreePath"] as const;

const TIMESTAMP_PROPERTIES = [
  "createdAt",
  "updatedAt",
  "archivedAt",
  "settledAt",
  "snoozedUntil",
  "pinnedAt",
  "deletedAt",
] as const;

describe("upstream-derived free-text fields carry their constraint into the artifact", () => {
  it.each(FREE_TEXT_PROPERTIES)("%s emits a minimum length and a non-blank pattern", (property) => {
    const constraints = stringConstraints(stringSchemaFor(property));
    expect(constraints.minLength).toBe(1);
    expect(constraints.pattern).toBeDefined();
    expect(new RegExp(constraints.pattern as string).test("   ")).toBe(false);
  });

  it.each(FREE_TEXT_PROPERTIES)("%s's emitted constraint refuses the empty string", (property) => {
    expect(emittedSchemaRefuses(stringSchemaFor(property), "")).toBe(true);
  });

  it.each(FREE_TEXT_PROPERTIES)(
    "%s's emitted constraint refuses a whitespace-only string",
    (property) => {
      expect(emittedSchemaRefuses(stringSchemaFor(property), "   ")).toBe(true);
    },
  );

  it("the artifact and the decoder refuse the same titles", () => {
    for (const candidate of ["", "   ", "\t\n"]) {
      expect(emittedSchemaRefuses(stringSchemaFor("title"), candidate)).toBe(
        decoderRefuses(candidate),
      );
    }
  });

  it("accepts a title that merely has padding, because the wire is not trimmed", () => {
    expect(emittedSchemaRefuses(stringSchemaFor("title"), " a ")).toBe(false);
    expect(decoderRefuses(" a ")).toBe(false);
  });

  it("pins the committed artifact to what the sources emit, for these fields", () => {
    // Without this, the assertions above could pass while the downloaded file disagrees.
    // Whole-document freshness is `jsonSchema.test.ts`'s job.
    const committed = committedThreadSummaryDocument();
    for (const property of FREE_TEXT_PROPERTIES) {
      expect(stringSchemaIn(committed, property)).toEqual(stringSchemaFor(property));
    }
  });
});

describe("projected timestamps stay as loose as the model they project", () => {
  // Refuses a plausible wrong edit: `IsoDateTime` IS a bare string, so there is no dropped check
  // to restore, and a constraint would refuse timestamps the fork itself accepts.
  it.each(TIMESTAMP_PROPERTIES)("%s emits no string constraint", (property) => {
    expect(stringConstraints(stringSchemaFor(property))).toEqual({});
  });

  it("the decoder accepts a timestamp the emitted document accepts", () => {
    expect(decoderRefuses("2026-08-22T00:00:00.000Z")).toBe(false);
  });
});
