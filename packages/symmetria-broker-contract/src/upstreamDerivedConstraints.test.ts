// @effect-diagnostics nodeBuiltinImport:off - these assertions read the emitted
// artifacts off disk, because the artifact is the thing under test. Same
// exemption, and same reason, as `jsonSchema.test.ts`.
import * as NodeFS from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildSymmetriaJsonSchemaArtifacts } from "./jsonSchema.ts";
import { SymmetriaThreadSummary } from "./threadSummary.ts";

/**
 * Issue #2: a check applied *after* a transformation is dropped when Effect
 * emits JSON Schema, and `TrimmedNonEmptyString` is built that way. So a field
 * composing it emitted as a bare `{"type":"string"}` while the decoder still
 * refused the empty string — the two consumer kinds disagreed, and the one
 * told the payload was fine was the one with no decoder behind it.
 *
 * These assertions pin both halves of the agreement: the schema the current
 * sources emit carries the constraint, and the decoder refuses exactly the
 * values that constraint refuses. One further assertion pins the committed
 * artifact to the emitted one for these three fields, so the file cannot pass
 * while the document a consumer downloads says something else.
 *
 * The last block pins the opposite, and it is not an oversight. Measured
 * 2026-08-22: `IsoDateTime` (`packages/contracts/src/baseSchemas.ts:21`) is
 * `Schema.String` with no check at all, so a bare `{"type":"string"}` for a
 * timestamp is a *faithful* emission and not a dropped constraint. Adding one
 * would make this projection stricter than the model it projects, and a thread
 * upstream considers valid would then fail to publish. `draft.ts` already
 * records the same fact twice in prose; this is the executable form.
 */

type JsonObject = Readonly<Record<string, unknown>>;

/**
 * The document these assertions judge is the one the CURRENT sources emit, not
 * the copy checked in under `schema/`.
 *
 * That distinction was not obvious and is the correction of a real defect in
 * the first version of this file, caught in review by reverting the fix in
 * `threadSummary.ts` and watching every assertion here stay green: reading only
 * the committed artifact made this file pass whenever the artifact was stale,
 * which is exactly when it should shout. The artifact's freshness is
 * `jsonSchema.test.ts`'s single responsibility and is not duplicated here — but
 * a file that depends on a sibling to be meaningful has to say so, or it reads
 * as self-sufficient and is trusted alone.
 *
 * `pinsTheCommittedArtifact` below closes the loop for these three fields only,
 * which is the narrowest pairing that makes this file honest on its own.
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
 * Collects `minLength` and `pattern` from a node, including the ones Effect
 * nests inside `allOf` when a value carries more than one check.
 *
 * This is deliberately not a JSON Schema validator. The repository has none,
 * and adding one would put a dependency in the root manifest — a new upstream
 * conflict surface every week for two keywords. So it reads exactly the two
 * keywords these assertions are about, and claims nothing about the rest of
 * the document.
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
  for (const property of FREE_TEXT_PROPERTIES) {
    it(`${property} emits a minimum length and a non-blank pattern`, () => {
      const constraints = stringConstraints(stringSchemaFor(property));
      expect(constraints.minLength).toBe(1);
      expect(constraints.pattern).toBeDefined();
      expect(new RegExp(constraints.pattern as string).test("   ")).toBe(false);
    });

    it(`${property}'s emitted constraint refuses the empty string`, () => {
      expect(emittedSchemaRefuses(stringSchemaFor(property), "")).toBe(true);
    });

    it(`${property}'s emitted constraint refuses a whitespace-only string`, () => {
      expect(emittedSchemaRefuses(stringSchemaFor(property), "   ")).toBe(true);
    });
  }

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
    // Without this, every assertion above could hold against a live document
    // while the file a consumer actually downloads said something else. It
    // checks these three properties only: the whole document's freshness is
    // `jsonSchema.test.ts`'s job and a second copy of that check would be one
    // more thing to keep in step.
    const committed = committedThreadSummaryDocument();
    for (const property of FREE_TEXT_PROPERTIES) {
      expect(stringSchemaIn(committed, property)).toEqual(stringSchemaFor(property));
    }
  });
});

describe("projected timestamps stay as loose as the model they project", () => {
  // A guard against a plausible and wrong future edit. Every field here emits a
  // bare string because `IsoDateTime` IS a bare string — there is no dropped
  // check to restore, and inventing one would make this projection refuse
  // timestamps the fork itself accepts. If a reader arrives here intending to
  // "finish" issue #2 by constraining timestamps, that is the edit this refuses.
  for (const property of TIMESTAMP_PROPERTIES) {
    it(`${property} emits no string constraint`, () => {
      expect(stringConstraints(stringSchemaFor(property))).toEqual({});
    });
  }

  it("the decoder accepts a timestamp the emitted document accepts", () => {
    expect(decoderRefuses("2026-08-22T00:00:00.000Z")).toBe(false);
  });
});
