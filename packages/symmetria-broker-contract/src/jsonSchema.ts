/**
 * The contract as JSON Schema, for consumers that are not TypeScript (Symmetria Shell is QML).
 * `Schema.toJsonSchemaDocument` derives one draft 2020-12 document per root from the same Effect
 * values. Nothing under `schema/` is written by hand. Building is pure, so tests compare in memory.
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
 * Every root a consumer validates a payload against. A union gets one document, not one per
 * member, so a consumer pins one thing and a member change moves the contract checksum.
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
 * Exported schemas that no emitted document covers. The suite requires every exported schema to
 * be a root, reachable from a root, or named here, so a schema missing from the emitter fails.
 * Each name is a local value that never goes on the wire: the pre-gate `AnnouncedProtocolVersion`
 * and the typed outcomes that the decode helpers return to their own caller.
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
 * Builds the publishable document for one root, following `buildT3ProjectFileJsonSchema`.
 * `definitions` must map onto `$defs`, because emitted references are written as `#/$defs/Name`.
 */
export const buildSymmetriaJsonSchemaDocument = (
  root: SymmetriaSchemaRoot,
): Record<string, unknown> => {
  // `additionalProperties: true` on purpose, unlike `t3.json`. The TypeScript decoder drops
  // unknown keys, so `false` would make a QML consumer reject payloads TypeScript accepts.
  // Do not tighten it. Effect 4.0.2 renamed the option: `onExcessProperty: "ignore"` is the
  // old `additionalProperties: true`.
  const document = Schema.toJsonSchemaDocument(root.schema, { onExcessProperty: "ignore" });
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
 * Builds the index over built artifacts. `checksum` covers the documents only, and a consumer
 * that is not TypeScript pins it. `sourceChecksum` covers the schema trees, so it catches a check
 * that emission drops without changing a document byte.
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
