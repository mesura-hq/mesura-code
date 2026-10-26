/**
 * One project as an outside surface sees it: an identifier and a label, nothing else.
 * `name`, not upstream's `title`, so a project label and a thread title never share one word.
 * ⚠ Keep project CONFIGURATION off this struct: the excluded-field list below is asserted.
 */
import { ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { NonEmptyText } from "./primitives.ts";

export const SymmetriaProjectSummary = Schema.Struct({
  projectId: ProjectId,
  // Not upstream's `TrimmedNonEmptyString`: its check is dropped on emission, and a consumer
  // told that `""` is a valid name draws an empty pill.
  name: NonEmptyText,
  // A positional `$defs` name (`Objects_1`) renumbers when a struct is added, and silently
  // repoints a consumer's pinned pointer at a different shape.
}).annotate({ identifier: "SymmetriaProjectSummary" });
export type SymmetriaProjectSummary = typeof SymmetriaProjectSummary.Type;

/**
 * The upstream project fields this projection refuses; the privacy test asserts this list.
 * `faviconPath` is a filesystem path into the workspace, which this wire refuses. Publishing
 * the project icon needs a deliberate decision about paths, not this field slipping through.
 */
export const SYMMETRIA_PROJECT_SUMMARY_EXCLUDED_UPSTREAM_FIELDS = [
  // Filesystem location of the checkout.
  "workspaceRoot",
  // Shell commands and the environment they carry.
  "scripts",
  // A path into the workspace. See the note above.
  "faviconPath",
  // Model and thread-start configuration: how the fork runs work, which is
  // nothing a surface listing projects renders.
  "defaultModelSelection",
  "defaultThreadEnvMode",
  // Version-control identity of the checkout.
  "repositoryIdentity",
] as const;
