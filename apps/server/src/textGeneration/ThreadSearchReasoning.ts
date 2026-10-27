/**
 * One bounded thread search step for `orchestration.reasonThreadSearch`: a plain text-generation
 * call that dispatches no command and starts no provider session. Mesura: `engine: "jev"` goes
 * to Jev via OpenRouter (`OPENROUTER_JEV_SEARCH_API_KEY`); with no key or no connection it fails
 * with `jevUnavailableError` and the client reruns on the configured model, never silently.
 */
import {
  jevUnavailableError,
  type OrchestrationThreadSearchReasoningInput,
  type OrchestrationThreadSearchStep,
  TextGenerationError,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { makeJevThreadSearch } from "./JevThreadSearch.ts";
import * as TextGeneration from "./TextGeneration.ts";

const OPERATION = "generateThreadSearchStep";
const JEV_API_KEY_ENV = "OPENROUTER_JEV_SEARCH_API_KEY";

export const makeReasonThreadSearch = Effect.gen(function* () {
  const apiKey = yield* Config.String(JEV_API_KEY_ENV).pipe(
    Config.option,
    Config.map(Option.filter((key) => key.trim().length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const jevSearch = Option.isSome(apiKey)
    ? yield* makeJevThreadSearch(apiKey.value.trim())
    : undefined;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;

  return (
    input: OrchestrationThreadSearchReasoningInput,
  ): Effect.Effect<OrchestrationThreadSearchStep, TextGenerationError> => {
    if (input.engine === "jev") {
      return jevSearch
        ? jevSearch(input)
        : Effect.fail(
            jevUnavailableError("OPENROUTER_JEV_SEARCH_API_KEY is not set on the server."),
          );
    }
    return Effect.gen(function* () {
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
      // The step needs no project, so it runs in an empty directory of its own
      // that is removed with the step.
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-thread-search-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: OPERATION,
                detail: "Failed to create the thread search working directory.",
                cause,
              }),
          ),
        );
      return yield* textGeneration.generateThreadSearchStep({ ...input, cwd, modelSelection });
    }).pipe(Effect.scoped);
  };
});
