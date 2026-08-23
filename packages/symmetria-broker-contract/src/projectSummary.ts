/**
 * One project, as a surface outside this fork sees it: an identifier and a word
 * to print. Nothing else.
 *
 * It exists because `SymmetriaThreadSummary` addresses a thread's project by
 * `projectId` and by nothing else, which is correct for addressing and useless
 * for rendering — a consumer grouping threads into project pills has an opaque
 * identifier where it needs a label. The alternative considered and rejected
 * was a project name on every thread summary: the name would then repeat on
 * every thread, two threads of one project could disagree about it, and a
 * project with no live thread would have no way to appear at all.
 *
 * `name` rather than `title`, which is what `OrchestrationProject`
 * (`orchestration.ts:245`) calls the same field. The projection renames it
 * deliberately, the way it renames `id` to `threadId`: a consumer renders a
 * project label and a thread label side by side in one row, and one word
 * meaning two things in one payload is the ambiguity this contract's whole
 * vocabulary discipline exists to prevent.
 *
 * ⚠ This struct is where project CONFIGURATION will try to get onto the wire.
 * `SymmetriaThreadSummary` already refuses `workspaceRoot` and `scripts`, with
 * the reasoning that a producer joining a thread to its project is exactly
 * where configuration gets folded in by accident. A project-shaped struct is
 * where that pressure lands next and is harder to refuse, because every one of
 * those fields is genuinely a property of a project. The list below is the
 * answer, and it is asserted rather than trusted.
 */
import { ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { NonEmptyText } from "./primitives.ts";

export const SymmetriaProjectSummary = Schema.Struct({
  projectId: ProjectId,
  // `NonEmptyText` rather than upstream's `TrimmedNonEmptyString`, for the
  // reason recorded at the free-text fields of `SymmetriaThreadSummary`: the
  // upstream check is dropped on emission, and this string is rendered. A
  // consumer told that `""` is a valid project name draws an empty pill.
  name: NonEmptyText,
  // The identifier names this struct in the emitted `$defs` instead of leaving
  // it at a positional `Objects_1`. Adding a struct is exactly the insertion
  // that renumbers positional names and silently repoints a consumer's pinned
  // pointer at a different shape.
}).annotate({ identifier: "SymmetriaProjectSummary" });
export type SymmetriaProjectSummary = typeof SymmetriaProjectSummary.Type;

/**
 * The upstream project fields this projection refuses, kept as a value so the
 * privacy test asserts against a list rather than against examples a reader
 * happened to pick.
 *
 * `faviconPath` is the one that will be argued about, so its reason is here
 * rather than only in the issue: publishing it would put a filesystem path
 * into the workspace on a wire that refuses `workspaceRoot` for being exactly
 * that. The project icon reaching Symmetria Shell is tracked as issue #12,
 * whose first item is that the shell cannot fetch what the fork's own resolver
 * returns — a signed asset URL. Whatever closes that issue is a deliberate
 * decision about paths on this wire, not this field slipping through.
 */
export const SYMMETRIA_PROJECT_SUMMARY_EXCLUDED_UPSTREAM_FIELDS = [
  // Filesystem location of the checkout.
  "workspaceRoot",
  // Shell commands and the environment they carry.
  "scripts",
  // A path into the workspace. See the note above and issue #12.
  "faviconPath",
  // Model and thread-start configuration: how the fork runs work, which is
  // nothing a surface listing projects renders.
  "defaultModelSelection",
  "defaultThreadEnvMode",
  // Version-control identity of the checkout.
  "repositoryIdentity",
] as const;
