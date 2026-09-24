import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { MesuraProjectFile, T3ProjectFile, T3_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link T3ProjectFile}.
 */
export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

/**
 * Decode raw `t3.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link T3_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}

export const MesuraProjectFileFromJson = fromLenientJson(MesuraProjectFile);

const decodeMesuraProjectFile = Schema.decodeExit(MesuraProjectFileFromJson);

/** Invalid repository defaults are absent; callers retain legacy and environment defaults. */
export function parseMesuraProjectFile(contents: string): MesuraProjectFile | null {
  const decoded = decodeMesuraProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/** Build the local editor schema without claiming an upstream or published schema URL. */
export function buildMesuraProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(Schema.toType(MesuraProjectFile));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $comment:
      "Generated from MesuraProjectFile. Run node scripts/generate-mesura-schema.ts from the repository root.",
    ...document.schema,
    ...(document.definitions && Object.keys(document.definitions).length > 0
      ? { $defs: document.definitions }
      : {}),
  };
}

export type RepositoryFileSource = "mesura" | "t3";

export interface RepositoryFileValue<Value> {
  readonly value: Value;
  readonly source: RepositoryFileSource;
}

const ABSENT_REPOSITORY_VALUE = { value: undefined, source: null } as const;

function firstRepositoryValue<Value>(
  mesuraValue: Value | undefined,
  legacyValue: Value | undefined,
): RepositoryFileValue<Value> | typeof ABSENT_REPOSITORY_VALUE {
  if (mesuraValue !== undefined) return { value: mesuraValue, source: "mesura" };
  if (legacyValue !== undefined) return { value: legacyValue, source: "t3" };
  return ABSENT_REPOSITORY_VALUE;
}

function repositoryFieldCandidates<Value>(
  mesuraValue: Value | undefined,
  legacyValue: Value | undefined,
): ReadonlyArray<RepositoryFileValue<Value>> {
  const candidates: Array<RepositoryFileValue<Value>> = [];
  if (mesuraValue !== undefined) candidates.push({ value: mesuraValue, source: "mesura" });
  if (legacyValue !== undefined) candidates.push({ value: legacyValue, source: "t3" });
  return candidates;
}

/** Resolve each field independently. Icon candidates retain the stale-path fallback order. */
export function resolveRepositoryDefaults(
  mesura: MesuraProjectFile | null,
  legacy: T3ProjectFile | null,
) {
  const iconCandidates = repositoryFieldCandidates(mesura?.iconPath, legacy?.iconPath);
  return {
    // The configured icon is exactly the first candidate. Icon discovery uses
    // the full list so a stale configured path can fall through to another file.
    iconPath: iconCandidates[0] ?? ABSENT_REPOSITORY_VALUE,
    defaultModelSelection: firstRepositoryValue(mesura?.defaultModelSelection, undefined),
    defaultThreadEnvMode: firstRepositoryValue(
      mesura?.defaultThreadEnvMode,
      legacy?.defaultThreadEnvMode,
    ),
    scripts: legacy?.scripts ?? [],
    iconCandidates,
  };
}

export type RepositoryDefaults = ReturnType<typeof resolveRepositoryDefaults>;
