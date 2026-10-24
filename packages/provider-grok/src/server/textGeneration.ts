import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { TextGenerationError } from "@t3tools/contracts";
import type { GrokSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  currentGrokReasoningEffortFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "./acpSupport.ts";
import { removeGrokSessionFiles, resolveGrokHome } from "./sessionFiles.ts";

const GROK_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/** Mesura: what an untrusted step records so it can remove the native session it created. */
interface GrokNativeSession {
  sessionId: string | undefined;
  readonly workingDirectories: Array<string>;
}

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const runGrokPrompt = <S extends Schema.Top>(
    request: TextGenerationOperations.Request<S>,
    nativeSession: GrokNativeSession | undefined,
  ) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      if (nativeSession !== undefined) {
        nativeSession.workingDirectories.push(cwd);
        // Grok may name the project after the resolved path.
        const resolved = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
        if (resolved !== cwd) nativeSession.workingDirectories.push(resolved);
      }
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeGrokAcpRuntime({
        grokSettings,
        environment,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const resolvedModel = resolveGrokAcpBaseModelId(modelSelection.model);
        const started = yield* runtime.start();
        if (nativeSession !== undefined) nativeSession.sessionId = started.sessionId;
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        yield* applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          currentReasoningEffort: currentGrokReasoningEffortFromSessionSetup(
            started.sessionSetupResult,
          ),
          requestedModelId: resolvedModel,
          requestedReasoningEffort,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Grok ACP base model for text generation.",
              cause,
            }),
        });
        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(request.timeoutMs ?? GROK_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Grok ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Grok ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Grok ACP request was cancelled."
              : "Grok Agent returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Grok Agent", trimmed);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Grok ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  /**
   * The shared runner. Mesura: an untrusted prompt (a thread search step)
   * quotes other threads, so the Grok session it creates is removed after the
   * process closes, and a transcript left behind fails the step.
   */
  const runGrokJson: TextGenerationOperations.Runner = (request) => {
    if (request.untrustedInput !== true) return runGrokPrompt(request, undefined);
    const nativeSession: GrokNativeSession = { sessionId: undefined, workingDirectories: [] };
    const removeNativeSession = Effect.suspend(() =>
      removeGrokSessionFiles({
        grokHome: resolveGrokHome(environment, homeDirectory),
        sessionId: nativeSession.sessionId,
        workingDirectories: nativeSession.workingDirectories,
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: request.operation,
            detail: "Grok could not remove its session files, so its transcript may remain.",
            cause,
          }),
      ),
    );
    return Effect.gen(function* () {
      // Its own empty directory, ignoring `request.cwd`: the session cleanup
      // removes the Grok project named for it, so nothing else may share it.
      const isolatedCwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-grok-search-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: request.operation,
                detail: "Failed to create Grok working directory.",
                cause,
              }),
          ),
        );
      return yield* runGrokPrompt({ ...request, cwd: isolatedCwd }, nativeSession).pipe(
        // A cancelled step cannot report a failure, but still removes its files.
        Effect.onInterrupt(() => removeNativeSession.pipe(Effect.ignore)),
        Effect.exit,
        // Runs after the scoped prompt closed the Grok process, so nothing rewrites the files.
        Effect.flatMap((exit) => Effect.andThen(removeNativeSession, exit)),
      );
    }).pipe(Effect.scoped);
  };

  return TextGenerationOperations.fromRunner("GrokTextGeneration", runGrokJson);
});
