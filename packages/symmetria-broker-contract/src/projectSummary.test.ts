import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Result from "effect/Result";

import { buildSymmetriaJsonSchemaArtifacts } from "./jsonSchema.ts";
import {
  SYMMETRIA_PROJECT_SUMMARY_EXCLUDED_UPSTREAM_FIELDS,
  SymmetriaProjectSummary,
} from "./projectSummary.ts";
import {
  applySymmetriaStreamDelta,
  decodeSymmetriaStreamItem as decodeStreamItem,
  openSymmetriaStream,
  SYMMETRIA_STREAM_CHANGE_ENTITIES,
  SymmetriaStreamChange,
  type SymmetriaStreamDelta,
} from "./stream.ts";
import { SYMMETRIA_CONTRACT_VERSION, SYMMETRIA_PROTOCOL_MINOR } from "./version.ts";

const decodeProject = Schema.decodeUnknownExit(SymmetriaProjectSummary);
const encodeProject = Schema.encodeUnknownExit(SymmetriaProjectSummary);
const decodeChange = Schema.decodeUnknownExit(SymmetriaStreamChange);

type JsonObject = Readonly<Record<string, unknown>>;

/**
 * The emitted document for one artifact, derived live from the current sources.
 *
 * Navigating to the exact node matters more than it looks. The first version of
 * these two assertions searched the STRINGIFIED document for `"minLength"` and
 * for `"SymmetriaProjectSummary"`, which passed for the wrong reason: the first
 * held only because `name` happens to be the one property in a two-field struct
 * that can emit a length, and the second would hold on a stray `$comment` long
 * after the `$defs` key it exists to check had disappeared. Review caught both.
 */
const documentFor = (file: string): JsonObject => {
  const artifact = buildSymmetriaJsonSchemaArtifacts().find((candidate) => candidate.file === file);
  if (artifact === undefined) throw new Error(`no emitted artifact for ${file}`);
  return artifact.document as unknown as JsonObject;
};

const definitionsOf = (document: JsonObject): Record<string, JsonObject> =>
  (document["$defs"] ?? {}) as Record<string, JsonObject>;

const projectSummaryProperties = (): Record<string, JsonObject> => {
  const document = documentFor("projectSummary.schema.json");
  const summary = definitionsOf(document)["SymmetriaProjectSummary"] ?? document;
  return (summary["properties"] ?? {}) as Record<string, JsonObject>;
};

const PROJECT = { projectId: "prj_vigilia", name: "vigilia" };

const SNAPSHOT = {
  type: "snapshot",
  protocolVersion: { major: 1, minor: SYMMETRIA_PROTOCOL_MINOR },
  revision: 7,
  threads: [],
  surfaces: [],
  drafts: [],
  projects: [PROJECT],
};

describe("SymmetriaProjectSummary", () => {
  it("decodes and re-encodes to the identical document", () => {
    const decoded = decodeProject(PROJECT);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag !== "Success") return;
    const encoded = encodeProject(decoded.value);
    expect(encoded._tag).toBe("Success");
    if (encoded._tag !== "Success") return;
    expect(encoded.value).toEqual(PROJECT);
  });

  it("refuses a name that is empty or blank", () => {
    for (const name of ["", "   "]) {
      expect(decodeProject({ projectId: "prj_1", name })._tag).toBe("Failure");
    }
  });

  it("carries the name constraint into the emitted artifact", () => {
    // The bar prints this string. A document that told a consumer `""` was a
    // valid project name would put an empty pill on screen — the same class of
    // defect issue #2 fixed for `title`, which is why this is asserted at the
    // moment the field is introduced rather than after somebody meets it.
    const name = projectSummaryProperties()["name"];
    expect(name).toBeDefined();
    expect(JSON.stringify(name)).toContain("minLength");
    expect(JSON.stringify(name)).toContain("pattern");
    // The sibling must NOT be where the constraint landed: `projectId` is a
    // re-exported upstream identifier and emits bare, which is what made the
    // whole-document search pass for the wrong reason.
    expect(JSON.stringify(projectSummaryProperties()["projectId"])).not.toContain("minLength");
  });

  it("names the struct by its own identifier in the emitted schema", () => {
    // Without the annotation Effect names reused definitions positionally
    // (`Objects_`, `Objects_1`), so inserting one struct renumbers the rest and
    // a consumer's pinned `$defs` pointer comes to mean a different shape.
    const definitions = definitionsOf(documentFor("streamItem.schema.json"));
    expect(Object.keys(definitions)).toContain("SymmetriaProjectSummary");
    // Exactly ONE definition still carries a positional name, and pinning the
    // count is what makes this assertion worth having.
    //
    // `Objects_` is `SymmetriaProtocolVersion`, which `version.ts` leaves
    // un-annotated deliberately — its WORKAROUND comment records that
    // annotating a root makes `toJsonSchemaDocument` emit that root's own
    // document as a bare `$ref`, which an approved test elsewhere reads
    // through. It is the reason positional naming is a live hazard here rather
    // than a theoretical one: a SECOND un-annotated struct would make the pair
    // `Objects_` and `Objects_1`, numbered by the order Effect met them, so
    // inserting a third would silently repoint a consumer's pinned `$defs`
    // pointer at a different shape. Asserting zero would fail today; asserting
    // one fails the moment that becomes possible.
    expect(Object.keys(definitions).filter((key) => key.startsWith("Objects_"))).toEqual([
      "Objects_",
    ]);
  });

  it("refuses project configuration on the wire", () => {
    // A producer joining a thread to its project is where scripts and the
    // workspace root get folded in by accident. The thread summary already
    // guards this; a project-shaped struct is where the pressure lands next.
    const forbidden = JSON.stringify(SYMMETRIA_PROJECT_SUMMARY_EXCLUDED_UPSTREAM_FIELDS);
    for (const field of ["workspaceRoot", "scripts", "faviconPath"]) {
      expect(forbidden).toContain(field);
    }
    const emitted = JSON.stringify(
      buildSymmetriaJsonSchemaArtifacts().find(
        (candidate) => candidate.file === "projectSummary.schema.json",
      )?.document,
    );
    for (const field of SYMMETRIA_PROJECT_SUMMARY_EXCLUDED_UPSTREAM_FIELDS) {
      expect(emitted).not.toContain(`"${field}"`);
    }
  });
});

describe("the stream carries projects", () => {
  it("opens with a snapshot listing them", () => {
    const decoded = decodeStreamItem(SNAPSHOT);
    if (Result.isFailure(decoded)) throw new Error("snapshot did not decode");
    const opened = openSymmetriaStream(decoded.success);
    if (Result.isFailure(opened)) throw new Error("snapshot did not open");
    expect(opened.success.projects).toEqual([PROJECT]);
  });

  it("accepts a delta tagged with the project entity", () => {
    const change = decodeChange({ entity: "project", project: PROJECT });
    expect(change._tag).toBe("Success");
    if (change._tag !== "Success") return;
    expect(change.value.entity).toBe("project");
  });

  it("lists the project entity among the ones a consumer branches on", () => {
    expect(SYMMETRIA_STREAM_CHANGE_ENTITIES).toContain("project");
  });

  it("upserts a project by its identifier when a delta is applied", () => {
    const decoded = decodeStreamItem(SNAPSHOT);
    if (Result.isFailure(decoded)) throw new Error("snapshot did not decode");
    const opened = openSymmetriaStream(decoded.success);
    if (Result.isFailure(opened)) throw new Error("snapshot did not open");
    const delta = decodeStreamItem({
      type: "delta",
      sequence: 8,
      change: { entity: "project", project: { projectId: "prj_vigilia", name: "vigilia-renamed" } },
    });
    if (Result.isFailure(delta)) throw new Error("delta did not decode");
    const applied = applySymmetriaStreamDelta(
      opened.success,
      delta.success as SymmetriaStreamDelta,
    );
    expect(applied.outcome).toBe("applied");
    expect(applied.state.projects).toEqual([{ projectId: "prj_vigilia", name: "vigilia-renamed" }]);
  });

  it("still degrades an entity this build has never heard of", () => {
    // The mechanism that makes adding `project` a MINOR bump rather than a
    // major one: a consumer built before this addition meets `"project"` the
    // way this build meets `"sprocket"`, and the item survives.
    //
    // Asserted through an unknown name rather than by simulating an older
    // build, because nothing in the package can construct one — the plan's
    // wording ("decodes as unknown under the previous minor") describes a
    // consumer this repository cannot instantiate. What is testable, and what
    // the guarantee actually rests on, is that the degradation path is intact.
    const change = decodeChange({ entity: "sprocket", sprocket: { anything: true } });
    expect(change._tag).toBe("Success");
    if (change._tag !== "Success") return;
    expect(change.value.entity).toBe("unknown");
  });

  it("still refuses a known entity carrying the wrong body", () => {
    // The guard that keeps the degradation from swallowing corruption. Adding
    // an entity widens the set this check consults, so it is re-asserted here.
    expect(decodeChange({ entity: "project", project: { nope: true } })._tag).toBe("Failure");
  });
});

describe("additive contract changes advance the minor version", () => {
  // Projects introduced 1.1. Dictation introduces 1.2 and carries an
  // EnvironmentId for the first time. Keeping the old exact assertions would
  // make a correct additive release look like a regression.
  it("announces the latest additive protocol surface", () => {
    expect(SYMMETRIA_PROTOCOL_MINOR).toBe(2);
  });

  it("keeps the semantic contract version in step", () => {
    expect(SYMMETRIA_CONTRACT_VERSION).toBe("1.2.0");
  });
});
