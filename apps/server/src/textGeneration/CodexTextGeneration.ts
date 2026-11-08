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
 * Codex args for a step over untrusted text. `--ignore-user-config` skips config.toml but keeps
 * auth from CODEX_HOME, and `--disable` wins over any `--enable` in launch args. codex-cli 0.156.0
 * still offers `apply_patch`, so the read-only sandbox and never-approve policy, set after launch
 * args, block writes. An unknown feature fails the run; 0.156.0 ignores `tools.view_image`.
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
/** Mesura: the shared operations plus the Codex-only project icon search. */
type CodexOperation = TextGenerationOperations.Operation | "selectProjectIcon";
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

// mcp_servers={} merges instead of replacing; disable named entries and quote dotted names.
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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
    fileSystem.remove(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);

  // Background fibers may inherit closed scopes that immediately reap temp files; write unscoped.
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

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const runCodexCommandJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    imagePaths,
    timeoutMs,
    investigate,
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
    readonly investigate?: TextGenerationOperations.Request<S>["investigate"];
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
      const binary = effectiveConfig.binaryPath || "codex";
      const env = {
        ...effectiveEnvironment,
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      const execLaunchArgs = codexExecLaunchArgs(launchArgs);
      const mcpServersOff = isolateTools
        ? null
        : yield* listEnabledMcpServers({
            binary,
            cwd: workingDirectory,
            env,
            // `codex mcp` rejects --strict-config; the overrides still apply.
            launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
          }).pipe(Effect.map(codexMcpServersOff));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...(isolateTools
            ? [...withoutMcpServerOverrides(execLaunchArgs), ...CODEX_NO_TOOLS_ARGS]
            : [
                ...execLaunchArgs,
                // A user's MCP server could act on the text-generation prompt.
                ...CODEX_NO_PLUGIN_ARGS,
                ...(mcpServersOff ? ["--config", mcpServersOff] : []),
              ]),
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
        env,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
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
        Effect.timeoutOption(timeoutMs ?? investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
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
          ...(request.investigate === undefined ? {} : { investigate: request.investigate }),
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
