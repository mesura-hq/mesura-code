/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts, linked source
 * control context, and output sanitizing live here so providers cannot drift
 * on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type { ProviderTextGeneration } from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";
import {
  buildThreadSearchStepPrompt,
  THREAD_SEARCH_STEP_TIMEOUT_MS,
  toThreadSearchStep,
} from "./threadSearchPrompt.ts";

export type Operation = keyof ProviderTextGeneration;

/** One prompt for a provider to run. */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /**
   * Mesura: the prompt quotes untrusted text, such as other threads' history in
   * a thread search step. A runner that can should then give the model no
   * tools and keep no native session or transcript of the run.
   */
  readonly untrustedInput?: boolean | undefined;
  /** Mesura: a tighter limit than the runner's own, such as one thread search step's. */
  readonly timeoutMs?: number | undefined;
}

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

/** `CodexTextGeneration` → `Codex`, for messages a user reads. */
const providerLabel = (name: string) => name.replace(/TextGeneration$/, "");

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(name: string, run: Runner): ProviderTextGeneration {
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  // Mesura: one step of an agent thread search. Its prompt quotes other
  // threads, so the runner treats it as untrusted, and a search runs several
  // steps, so each gets the shorter per-step limit.
  const generateThreadSearchStep: ProviderTextGeneration["generateThreadSearchStep"] = Effect.fn(
    `${name}.generateThreadSearchStep`,
  )(function* (input) {
    const request = yield* buildThreadSearchStepPrompt(input);
    const generated = yield* run({
      operation: "generateThreadSearchStep",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      untrustedInput: true,
      timeoutMs: THREAD_SEARCH_STEP_TIMEOUT_MS,
      ...request,
    });
    return yield* toThreadSearchStep(providerLabel(name), generated);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateThreadSearchStep,
  } satisfies ProviderTextGeneration;
}
