import {
  FactorySnapshotDigest,
  McpCapabilityUnavailableError,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as FactorySnapshotStore from "../../../factory/FactorySnapshotStore.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  FactorySnapshotStore.FactorySnapshotStore,
];

/** The largest plan or intent file `present_plan` reads. */
export const FACTORY_DOCUMENT_MAX_BYTES = 1024 * 1024;

/**
 * The most UTF-8 bytes a plan's title, headings and phase titles may take together.
 * They travel in the plan activity, which every client replays; a plan in the
 * heading contract uses about 1 KiB of it.
 */
export const FACTORY_PLAN_METADATA_MAX_BYTES = 16 * 1024;

export const PresentPlanInput = Schema.Struct({
  planPath: TrimmedNonEmptyString.annotate({
    description: "Absolute path to the plan.md the planning skill wrote.",
  }),
  intentPath: TrimmedNonEmptyString.annotate({
    description: "Absolute path to the intent.md beside that plan.",
  }),
});
export type PresentPlanInput = typeof PresentPlanInput.Type;

export const PresentPlanResult = Schema.Struct({
  digest: FactorySnapshotDigest.annotate({
    description: "sha256 of the plan bytes presented; approval names this digest.",
  }),
  intentDigest: FactorySnapshotDigest,
  title: Schema.String,
  phaseCount: NonNegativeInt,
});
export type PresentPlanResult = typeof PresentPlanResult.Type;

const FactoryDocumentProblem = Schema.Literals([
  "relative-path",
  "not-found",
  "not-regular-file",
  "too-large",
  "read-failed",
  "invalid-plan",
  "metadata-too-large",
]);
export type FactoryDocumentProblem = typeof FactoryDocumentProblem.Type;

/** A plan or intent file the tool refuses; the message names the file and the cause. */
export class FactoryPresentPlanError extends Schema.TaggedError<FactoryPresentPlanError>()(
  "FactoryPresentPlanError",
  {
    reason: FactoryDocumentProblem,
    path: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "relative-path":
        return `${this.path} is not an absolute path. Pass absolute paths to plan.md and intent.md.`;
      case "not-found":
        return `${this.path} was not found.`;
      case "not-regular-file":
        return `${this.path} is not a regular file.`;
      case "too-large":
        return `${this.path} is larger than 1 MiB.`;
      case "read-failed":
        return `${this.path} could not be read.`;
      case "invalid-plan":
        return `${this.path} is not a valid plan: ${this.detail ?? "it does not parse."}`;
      case "metadata-too-large":
        return `${this.path} has a title, headings and phase titles over the 16 KiB a plan card carries${this.detail === undefined ? "" : ` (${this.detail})`}. Shorten or merge them.`;
    }
  }
}

export class FactoryPresentPlanFailedError extends Schema.TaggedError<FactoryPresentPlanFailedError>()(
  "FactoryPresentPlanFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not present the plan.";
  }
}

export const FactoryToolError = Schema.Union([
  McpCapabilityUnavailableError,
  FactoryPresentPlanError,
  FactoryPresentPlanFailedError,
]);
export type FactoryToolError = typeof FactoryToolError.Type;

const PresentPlanTool = Tool.make("present_plan", {
  description:
    "Present a Software Factory plan in this thread as a card the user reads and approves. Pass absolute paths to the plan.md and intent.md you wrote. The server keeps the exact bytes under their sha256 and returns that digest; presenting the same plan file again after an edit replaces its card. Fails, naming the file and the cause, when a path is relative, a file is missing or over 1 MiB, or the plan's phases block does not parse.",
  parameters: PresentPlanInput,
  success: PresentPlanResult,
  failure: FactoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "Present plan in thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const FactoryToolkit = Toolkit.make(PresentPlanTool);
