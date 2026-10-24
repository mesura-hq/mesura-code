import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  ProjectIconSelection,
  ProjectIconSelectionUnavailable,
  type ProjectIconSelectionInput,
} from "@t3tools/provider-core/server/projectIconSelection";
import {
  makeProjectIconSelectionRequest,
  offersProjectIconSelectionModel,
  PROJECT_ICON_SELECTION_MODEL,
  PROJECT_ICON_SELECTION_TIMEOUT_MS,
} from "../project/ProjectIconSelection.ts";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CODEX_TIMEOUT_MS = 180_000;

/**
 * Arguments for a Codex step that reasons over untrusted text.
 * `--ignore-user-config` skips config.toml (MCP servers, plugins, profiles)
 * while auth still loads from CODEX_HOME. Codex applies `--disable` over any
 * `--enable`, so launch args cannot restore a tool.
 *
 * Checked against real codex-cli 0.156.0 through a local Responses endpoint:
 * the model then sees only `request_user_input` and `apply_patch`. Codex picks
 * `apply_patch` per model and offers no switch for it, so writes rest on the
 * read-only sandbox and the never-approve policy, pinned here after launch args
 * so those cannot relax them; the probe saw every patch rejected. An unknown
 * feature name fails the run, and `tools.view_image` is ignored by that version,
 * which is why `view_image` is disabled as a feature.
 */
const CODEX_NO_TOOLS_ARGS: ReadonlyArray<string> = [
  "--ignore-user-config",
  "--ignore-rules",
  ...[
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "remote_plugin",
    "hooks",
    "multi_agent",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "memories",
    "goals",
    "skill_search",
    "tool_suggest",
    "sleep_tool",
    "view_image",
  ].flatMap((feature) => ["--disable", feature]),
  "--config",
  'web_search="disabled"',
  "--config",
  'sandbox_mode="read-only"',
  "--config",
  'approval_policy="never"',
];

const isMcpServerOverride = (value: string) => /^mcp_servers[.=]/.test(value);

/** Drop `-c mcp_servers.…` overrides, which `--ignore-user-config` does not skip. */
function withoutMcpServerOverrides(execArgs: ReadonlyArray<string>): ReadonlyArray<string> {
  const kept: Array<string> = [];
  for (let index = 0; index < execArgs.length; index++) {
    const arg = execArgs[index];
    if (arg === undefined) continue;
    const next = execArgs[index + 1];
    if ((arg === "--config" || arg === "-c") && next !== undefined) {
      if (!isMcpServerOverride(next)) kept.push(arg, next);
      index++;
      continue;
    }
    const inline = /^(?:--config|-c)=(.*)$/.exec(arg);
    if (inline?.[1] !== undefined && isMcpServerOverride(inline[1])) continue;
    kept.push(arg);
  }
  return kept;
}
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/** Mesura: the shared operations plus the Codex-only project icon search. */
type CodexOperation = TextGenerationOperations.Operation | "selectProjectIcon";
/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem
      .remove(path.dirname(filePath), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));

  // Deliberately unscoped: text generation runs from background fibers whose
  // ambient scope may already be closed (a closed scope reaps the temp
  // directory the moment it is created). Each allocation removes its own
  // directory on failure; success-path cleanup is explicit in runCodexJson.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation: CodexOperation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const runCodexCommandJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    imagePaths,
    timeoutMs = CODEX_TIMEOUT_MS,
    isolateTools = false,
  }: {
    readonly operation: CodexOperation;
    /** Undefined runs Codex in an empty temporary directory instead of a project. */
    readonly cwd: string | undefined;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
    readonly imagePaths: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    /** Mesura: run with no tools at all; see `CODEX_NO_TOOLS_ARGS`. */
    readonly isolateTools?: boolean;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const workingDirectory =
        cwd ??
        (yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-codex-isolated-" })
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to create working directory"),
            ),
          ));
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolved ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const spawnCommand = yield* resolveSpawnCommand(
        effectiveConfig.binaryPath || "codex",
        [
          "exec",
          ...(isolateTools
            ? [
                ...withoutMcpServerOverrides(codexExecLaunchArgs(launchArgs)),
                ...CODEX_NO_TOOLS_ARGS,
              ]
            : codexExecLaunchArgs(launchArgs)),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: {
          ...effectiveEnvironment,
          ...(effectiveConfig.homePath
            ? {
                CODEX_HOME: expandHomePath(
                  effectiveConfig.homePath,
                  yield* HostProcess.HomeDirectory,
                ),
              }
            : {}),
        },
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all([removeTempFileDir(schemaPath), removeTempFileDir(outputPath)], {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  /**
   * The shared runner. Mesura: an untrusted prompt (a thread search step) runs
   * with no tools; see `CODEX_NO_TOOLS_ARGS`.
   */
  const runCodexJson = <S extends Schema.Top>(request: TextGenerationOperations.Request<S>) =>
    materializeImageAttachments(request.attachments).pipe(
      Effect.flatMap((imagePaths) =>
        runCodexCommandJson({
          operation: request.operation,
          cwd: request.cwd,
          prompt: request.prompt,
          outputSchema: request.outputSchema,
          modelSelection: request.modelSelection,
          imagePaths,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          isolateTools: request.untrustedInput === true,
        }),
      ),
    );

  /**
   * Mesura: Luna picks a project icon from local candidates. Codex-only, so it
   * stays off the provider-wide text generation contract; the driver exposes it
   * as the instance's `selectProjectIcon` capability.
   */
  const selectProjectIcon = Effect.fn("CodexTextGeneration.selectProjectIcon")(function* (
    instanceId: ProviderInstanceId,
    input: ProjectIconSelectionInput,
  ) {
    if (!offersProjectIconSelectionModel(yield* getModels)) {
      return yield* new ProjectIconSelectionUnavailable({
        detail: `${PROJECT_ICON_SELECTION_MODEL} is not available on this Codex instance.`,
      });
    }
    const request = yield* makeProjectIconSelectionRequest(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: "selectProjectIcon",
            detail: "Failed to read the candidate images.",
            cause,
          }),
      ),
    );
    return yield* runCodexCommandJson({
      operation: "selectProjectIcon",
      cwd: undefined,
      isolateTools: true,
      prompt: request.prompt,
      imagePaths: request.imagePaths,
      timeoutMs: PROJECT_ICON_SELECTION_TIMEOUT_MS,
      outputSchema: ProjectIconSelection,
      modelSelection: {
        instanceId,
        model: PROJECT_ICON_SELECTION_MODEL,
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });
  });

  return {
    ...TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson),
    selectProjectIcon,
  };
});
