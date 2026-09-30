/**
 * The server side of `orchestration.reasonThreadSearch`: one bounded agent
 * thread search step, answered by the text-generation model this environment
 * configured.
 *
 * The step is a plain text-generation call. It dispatches no orchestration
 * command and starts no provider session, so it never becomes a thread.
 *
 * @module ThreadSearchReasoning
 */
import {
  type OrchestrationThreadSearchReasoningInput,
  type OrchestrationThreadSearchStep,
  TextGenerationError,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";

const OPERATION = "generateThreadSearchStep";

export const makeReasonThreadSearch = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  return (
    input: OrchestrationThreadSearchReasoningInput,
  ): Effect.Effect<OrchestrationThreadSearchStep, TextGenerationError> =>
    Effect.gen(function* () {
      // Read the selection as configured, not the fallback `getSettings`
      // substitutes for a disabled provider: search must not switch providers.
      const [modelSelection, settings] = yield* Effect.all([
        serverSettings.getConfiguredTextGenerationModelSelection,
        serverSettings.getSettings,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: OPERATION,
              detail: "Failed to read the text generation settings.",
              cause,
            }),
        ),
      );
      if (!isModelSelectionProviderEnabled(settings, modelSelection)) {
        return yield* new TextGenerationError({
          operation: OPERATION,
          detail: `The configured text generation provider '${modelSelection.instanceId}' is disabled. Enable it or choose another text generation model.`,
        });
      }
      return yield* textGeneration.generateThreadSearchStep({ ...input, modelSelection });
    });
});
