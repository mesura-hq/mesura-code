/**
 * The contract as a consumer that is not TypeScript reads it.
 *
 * Symmetria Shell is QML. It cannot import an Effect schema, so everything the
 * earlier phases stated in TypeScript has to reach it as JSON Schema. This
 * module is the projection: one draft 2020-12 document per root schema, built
 * from the same Effect values the TypeScript consumers decode with. There is no
 * second description of any fact here — `Schema.toJsonSchemaDocument` derives
 * every document, and nothing under `schema/` is ever written by hand.
 *
 * The building is pure and lives here rather than in the emitter script, so the
 * tests can rebuild every document in memory and compare it against the file on
 * disk without running the script or touching the filesystem.
 */
import * as Schema from "effect/Schema";

import { SymmetriaCommandEnvelope, SymmetriaCommandReceipt } from "./command.ts";
import {
  SymmetriaDictationCommand,
  SymmetriaDictationReceipt,
  SymmetriaDictationSession,
} from "./dictation.ts";
import { SymmetriaProjectSummary } from "./projectSummary.ts";
import { SymmetriaDraft, SymmetriaDraftUpdate, SymmetriaDraftUpdateResult } from "./draft.ts";
import { SymmetriaStreamItem } from "./stream.ts";
import { SymmetriaSurfacePresence } from "./surfacePresence.ts";
import { SymmetriaThreadSummary } from "./threadSummary.ts";
import {
  computeSymmetriaContractChecksum,
  computeSymmetriaSourceChecksum,
  formatSymmetriaSchemaDocument,
  SYMMETRIA_SCHEMA_INDEX_FILE,
} from "./checksum.ts";
import { SYMMETRIA_CONTRACT_VERSION } from "./version.ts";

/** The one dialect every emitted document declares. */
export const SYMMETRIA_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** One root schema and the file its document is emitted to. */
export type SymmetriaSchemaRoot = {
  /** The exported name of the Effect schema this document is derived from. */
  readonly root: string;
  /** Path of the document relative to the `schema/` directory. */
  readonly file: string;
  /** One line on what a consumer validates against it. */
  readonly summary: string;
  readonly schema: Schema.Top;
};

/**
 * Every root a consumer validates a payload against.
 *
 * A union gets one document covering all of its members rather than one per
 * member: `SymmetriaCommandEnvelope` is how a consumer sends any of the four
 * commands, so an activation payload validates against the envelope document
 * and a change to the activation member moves the contract checksum. Splitting
 * the union would give a consumer four things to pin where the contract has
 * one.
 */
export const SYMMETRIA_SCHEMA_ROOTS: ReadonlyArray<SymmetriaSchemaRoot> = [
  {
    root: "SymmetriaThreadSummary",
    file: "threadSummary.schema.json",
    summary: "The narrow read projection of one agent thread.",
    schema: SymmetriaThreadSummary,
  },
  {
    root: "SymmetriaSurfacePresence",
    file: "surfacePresence.schema.json",
    summary: "Which surfaces attend one thread, and how attentive each one is.",
    schema: SymmetriaSurfacePresence,
  },
  {
    root: "SymmetriaCommandEnvelope",
    file: "commandEnvelope.schema.json",
    summary: "Any of the four commands a consumer sends, with its command identifier.",
    schema: SymmetriaCommandEnvelope,
  },
  {
    root: "SymmetriaCommandReceipt",
    file: "commandReceipt.schema.json",
    summary: "The answer to one command, whether it applied, replayed or was refused.",
    schema: SymmetriaCommandReceipt,
  },
  {
    root: "SymmetriaDictationSession",
    file: "dictationSession.schema.json",
    summary: "The non-transcript snapshot of one Shell-owned dictation session.",
    schema: SymmetriaDictationSession,
  },
  {
    root: "SymmetriaDictationCommand",
    file: "dictationCommand.schema.json",
    summary: "A reserved-session control, presentation update or delivery command.",
    schema: SymmetriaDictationCommand,
  },
  {
    root: "SymmetriaDictationReceipt",
    file: "dictationReceipt.schema.json",
    summary: "The confirmed effect or typed failure of one dictation command.",
    schema: SymmetriaDictationReceipt,
  },
  {
    root: "SymmetriaDraft",
    file: "draft.schema.json",
    summary: "The versioned composer draft of one thread.",
    schema: SymmetriaDraft,
  },
  {
    root: "SymmetriaDraftUpdate",
    file: "draftUpdate.schema.json",
    summary: "A compare-and-set write of a draft, stating the version it expects.",
    schema: SymmetriaDraftUpdate,
  },
  {
    root: "SymmetriaDraftUpdateResult",
    file: "draftUpdateResult.schema.json",
    summary: "The outcome of a draft update, applied or refused as a conflict.",
    schema: SymmetriaDraftUpdateResult,
  },
  {
    root: "SymmetriaProjectSummary",
    file: "projectSummary.schema.json",
    summary: "One project's identity: what a consumer prints above the threads it groups.",
    schema: SymmetriaProjectSummary,
  },
  {
    root: "SymmetriaStreamItem",
    file: "streamItem.schema.json",
    summary: "One item of the stream, either a full snapshot or a delta.",
    schema: SymmetriaStreamItem,
  },
];

/**
 * Schemas the package exports that no emitted document covers, and why.
 *
 * The root list above is written by hand, so on its own nothing would notice a
 * wire schema added by a later run and never added here: it would ship with no
 * document, no index entry, and no movement in the value a consumer pins. The
 * suite closes that by walking every schema the barrel exports and requiring
 * each one to be a root, to be reachable inside a root's tree, or to be named
 * here. Adding a schema and forgetting the emitter therefore fails the suite.
 *
 * Each name here is a value this fork computes locally and never puts on the
 * wire:
 * - `AnnouncedProtocolVersion` is the unchecked pair a peer sends *before* the
 *   version gate runs. What a payload carries is `SymmetriaProtocolVersion`,
 *   which is inside the envelope, the receipt and the stream documents.
 * - `SymmetriaProtocolVersionRejection` and its two members, plus
 *   `SymmetriaStreamNotOpened` and `SymmetriaStreamItemMalformed`, are the
 *   typed outcomes the decode helpers return to their own caller. Nothing
 *   transmits them, and this run builds no transport that could.
 * `EnvironmentId` used to be named here because no projection carried it. A
 * dictation target now carries the environment boundary, so the schema became
 * reachable from three published roots and the exemption had to disappear.
 */
export const SYMMETRIA_UNPUBLISHED_SCHEMAS: ReadonlyArray<string> = [
  "AnnouncedProtocolVersion",
  "SymmetriaProtocolVersionMalformed",
  "SymmetriaProtocolVersionMismatch",
  "SymmetriaProtocolVersionRejection",
  "SymmetriaStreamItemMalformed",
  "SymmetriaStreamNotOpened",
];

/**
 * Builds the publishable document for one root.
 *
 * Follows `buildT3ProjectFileJsonSchema` (`packages/shared/src/t3ProjectFile.ts:32`),
 * which is the fork's own convention: spread the returned `schema` under a
 * `$schema` and `$id` header and map the returned `definitions` onto `$defs`.
 * The renaming is not cosmetic — emitted references are written as
 * `#/$defs/Name`, so a document that kept the pool under `definitions` would
 * resolve none of them.
 */
export const buildSymmetriaJsonSchemaDocument = (
  root: SymmetriaSchemaRoot,
): Record<string, unknown> => {
  // `additionalProperties: true`, diverging from the `t3.json` precedent, and
  // it is not looseness. The contract requires a consumer to ignore additive
  // unknown fields, and the TypeScript decoder already does exactly that: it
  // drops an unknown key at every depth rather than failing. Emitting the
  // default of `false` would make a QML consumer reject the very payload a
  // TypeScript consumer accepts, so the two consumer kinds would disagree on
  // the first additive field this contract ever ships. Do not tighten it.
  const document = Schema.toJsonSchemaDocument(root.schema, { additionalProperties: true });
  const jsonSchema: Record<string, unknown> = {
    $schema: SYMMETRIA_JSON_SCHEMA_DIALECT,
    $id: root.file,
    title: root.root,
    $comment: `Generated from ${root.root} by scripts/emit-json-schema.ts. Do not hand-edit.`,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
};

/** One emitted artifact: where it goes, what it says, and its exact bytes. */
export type SymmetriaSchemaArtifact = {
  readonly file: string;
  readonly root: string;
  readonly summary: string;
  readonly document: Record<string, unknown>;
  readonly source: string;
};

/** Builds every document in memory, in the order the index lists them. */
export const buildSymmetriaJsonSchemaArtifacts = (): ReadonlyArray<SymmetriaSchemaArtifact> =>
  [...SYMMETRIA_SCHEMA_ROOTS]
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .map((root) => {
      const document = buildSymmetriaJsonSchemaDocument(root);
      return {
        file: root.file,
        root: root.root,
        summary: root.summary,
        document,
        source: formatSymmetriaSchemaDocument(document),
      };
    });

/** The index a consuming repository reads: what exists, at what version, hashed. */
export type SymmetriaSchemaIndex = {
  readonly contractVersion: string;
  readonly checksum: string;
  readonly sourceChecksum: string;
  readonly schemas: ReadonlyArray<{
    readonly root: string;
    readonly file: string;
    readonly summary: string;
  }>;
};

/**
 * Builds the index over already-built artifacts. The document checksum covers
 * the documents only and never the index itself, which could not hash its own
 * bytes anyway.
 *
 * `sourceChecksum` covers the schema trees instead, and it is what catches an
 * edit JSON Schema cannot express — a check dropped on emission changes no
 * document byte, so the document checksum alone would report a weakened
 * contract as unchanged. Both values are recorded; a consumer that is not
 * TypeScript pins `checksum`, which it can reproduce from the published bytes.
 */
export const buildSymmetriaSchemaIndex = (
  artifacts: ReadonlyArray<SymmetriaSchemaArtifact>,
): SymmetriaSchemaIndex => ({
  contractVersion: SYMMETRIA_CONTRACT_VERSION,
  checksum: computeSymmetriaContractChecksum(artifacts),
  sourceChecksum: computeSymmetriaSourceChecksum(
    SYMMETRIA_SCHEMA_ROOTS.map((root) => ({ root: root.root, ast: root.schema.ast })),
  ),
  schemas: artifacts.map((artifact) => ({
    root: artifact.root,
    file: artifact.file,
    summary: artifact.summary,
  })),
});

/** Every file the emitter writes, index included, ready to be put on disk. */
export const buildSymmetriaSchemaArtifactSet = (): ReadonlyArray<{
  readonly file: string;
  readonly source: string;
}> => {
  const artifacts = buildSymmetriaJsonSchemaArtifacts();
  return [
    ...artifacts.map(({ file, source }) => ({ file, source })),
    {
      file: SYMMETRIA_SCHEMA_INDEX_FILE,
      source: formatSymmetriaSchemaDocument(buildSymmetriaSchemaIndex(artifacts)),
    },
  ];
};
