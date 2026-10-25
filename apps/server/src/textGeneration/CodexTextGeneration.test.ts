import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import {
  CodexSettings,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  THREAD_SEARCH_BROADEN_MODEL_OUTPUT,
  THREAD_SEARCH_BROADEN_STEP,
  THREAD_SEARCH_EMPTY_INSPECT_MODEL_OUTPUT,
  THREAD_SEARCH_FINISH_MODEL_OUTPUT,
  THREAD_SEARCH_FINISH_STEP,
  THREAD_SEARCH_FORBIDDEN_MODEL_OUTPUT,
  THREAD_SEARCH_STEP_REQUEST,
  THREAD_SEARCH_QUOTED_EXCERPT,
  THREAD_SEARCH_STEP_EXCERPT,
  THREAD_SEARCH_STEP_CWD,
} from "@t3tools/provider-testing/threadSearchStep";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCodexInput {
  output: string;
  lifecycle?: { port: number; command: "exec" | "mcp list" };
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  /**
   * Config values the run must end up with, resolved the way codex-cli does:
   * the last `-c`/`--config` for a key wins.
   */
  requireEffectiveConfig?: Record<string, string>;
  /** Features that must end up off; codex-cli applies `--disable` over any `--enable`. */
  requireDisabledFeatures?: ReadonlyArray<string>;
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
}

function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    requireImage: input.requireImage ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    requireEffectiveConfig: input.requireEffectiveConfig ?? {},
    requireDisabledFeatures: input.requireDisabledFeatures ?? [],
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    mcpServers: input.mcpServers ?? [],
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        'const isMcpList = args.includes("mcp") && args.includes("list");',
        ...(input.lifecycle === undefined
          ? []
          : [
              `if (isMcpList === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (isMcpList) {",
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        "  process.stdout.write(JSON.stringify(check.mcpServers));",
        "  process.exit(0);",
        "}",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        "const effectiveConfig = {};",
        "const disabledFeatures = new Set();",
        "for (let index = 0; index < args.length; index += 1) {",
        "  const arg = args[index];",
        "  const inline = /^(?:--config|-c)=(.*)$/.exec(arg);",
        '  const setting = inline ? inline[1] : arg === "--config" || arg === "-c" ? args[++index] : null;',
        "  if (setting) {",
        '    const separator = setting.indexOf("=");',
        '    effectiveConfig[setting.slice(0, separator)] = setting.slice(separator + 1).replace(/^"|"$/g, "");',
        '  } else if (arg === "--disable") {',
        "    disabledFeatures.add(args[++index]);",
        "  }",
        "}",
        "for (const [key, value] of Object.entries(check.requireEffectiveConfig)) {",
        "  if (effectiveConfig[key] !== value) {",
        '    fail("effective " + key + " was " + effectiveConfig[key], 10);',
        "  }",
        "}",
        "for (const feature of check.requireDisabledFeatures) {",
        '  if (!disabledFeatures.has(feature)) fail("feature left enabled: " + feature, 11);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    managedRuntime?: boolean;
  },
  effectFn: (
    textGeneration: Effect.Success<ReturnType<typeof makeCodexTextGeneration>>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath, launchArgs: input.launchArgs });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.environment === undefined ? undefined : { ...process.env, ...input.environment },
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      input.managedRuntime
        ? Effect.succeed({
            config,
            environment: input.environment ?? process.env,
            revision: "test",
          })
        : undefined,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerCodexTextGenerationTest)("CodexTextGeneration", (it) => {
  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration
                .generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                })
                .pipe(Effect.forkScoped);
              yield* probe.started;

              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );

  it.effect.each(["gpt-5.6-luna", "openai.gpt-5.6-luna"])(
    "dispatches the qualified live model for %s",
    (selectedModel) =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
  );

  it.effect("omits a persisted service tier for managed ChatGPT text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Update project", body: "" }),
        managedRuntime: true,
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/chatgpt",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("generates titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArg:
          '--config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Augmenter task 1. Use the Augmenter MCP: link_thread when you start.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("still generates when Codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArg: "mcp_servers=",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.branch).toBe("remove-default-shapes");
        }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArg:
          "--config features.plugins=true --config features.apps=true --config features.plugins=false --config features.apps=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates branch names even when the ambient scope is already closed", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "feat/background-generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Background fibers (e.g. the worktree branch rename fork) can run
          // after their launching request's scope has closed; temp files must
          // not be tied to that ambient scope or they are reaped on creation.
          const closedScope = yield* Scope.make();
          yield* Scope.close(closedScope, Exit.void);

          const generated = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Please update session handling.",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.provideService(Scope.Scope, closedScope));

          expect(generated.branch).toBe("feat/background-generation");
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.ignore);

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );

  // Guard: every Codex text-generation task already runs as an ephemeral,
  // read-only exec. The thread search step must inherit that isolation.
  it.effect.each(["--ephemeral", "-s read-only"])(
    "keeps existing Codex thread titles isolated with %s",
    (isolationArg) =>
      withFakeCodexEnv(
        { output: JSON.stringify({ title: "Isolated title" }), requireArg: isolationArg },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(generated.title).toBe("Isolated title");
          }),
      ),
  );

  // Agent thread search, phase 2.
  it.effect.each(["--ephemeral", "-s read-only", "--model gpt-5.4-mini"])(
    "Codex answers a schema-checked thread search step with %s",
    (requiredArg) =>
      withFakeCodexEnv(
        {
          output: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
          requireArg: requiredArg,
          // Evidence reaches the model JSON-quoted, never as raw prompt lines.
          stdinMustContain: THREAD_SEARCH_QUOTED_EXCERPT,
          stdinMustNotContain: THREAD_SEARCH_STEP_EXCERPT,
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const step = yield* textGeneration.generateThreadSearchStep({
              ...THREAD_SEARCH_STEP_REQUEST,
              cwd: THREAD_SEARCH_STEP_CWD,
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
          }),
      ),
  );

  it.effect("Codex answers a broaden thread search step with its new terms", () =>
    withFakeCodexEnv({ output: THREAD_SEARCH_BROADEN_MODEL_OUTPUT }, (textGeneration) =>
      Effect.gen(function* () {
        const step = yield* textGeneration.generateThreadSearchStep({
          ...THREAD_SEARCH_STEP_REQUEST,
          cwd: THREAD_SEARCH_STEP_CWD,
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(step).toEqual(THREAD_SEARCH_BROADEN_STEP);
      }),
    ),
  );

  // Effect each passes the whole case first and TestContext second; destructure tuple cases.
  it.effect.each([
    ["a write action", THREAD_SEARCH_FORBIDDEN_MODEL_OUTPUT],
    ["an inspect step without candidates", THREAD_SEARCH_EMPTY_INSPECT_MODEL_OUTPUT],
    ["non-JSON text", "I could not find it."],
  ] as const)("Codex rejects %s as a thread search step", ([_label, output]) =>
    withFakeCodexEnv({ output }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* textGeneration
          .generateThreadSearchStep({
            ...THREAD_SEARCH_STEP_REQUEST,
            cwd: THREAD_SEARCH_STEP_CWD,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.operation).toBe("generateThreadSearchStep");
        expect(error.message).toMatch(/invalid structured output/i);
      }),
    ),
  );

  // Review P1-1: search reasoning must not reach Codex tools. The user's
  // config.toml (MCP servers, plugins, profiles) and exec rules are skipped,
  // every tool feature is disabled (disable wins over any --enable), and an
  // MCP server injected through launch args is dropped for this operation.
  it.effect.each([
    "--ignore-user-config",
    "--ignore-rules",
    "--disable shell_tool",
    "--disable unified_exec",
    "--disable apps",
    "--disable plugins",
    "--disable hooks",
    "--disable multi_agent",
    "--disable browser_use",
    "--disable computer_use",
    "--disable image_generation",
    '--config web_search="disabled"',
    // Checked against real codex-cli 0.156.0 through a local Responses
    // endpoint: `--disable view_image` removes the image tool the model sees.
    "--disable view_image",
    // apply_patch stays model-visible (Codex chooses it per model), so writes
    // rest on these two; they follow launch args so those cannot relax them.
    '--config sandbox_mode="read-only"',
    '--config approval_policy="never"',
  ])("Codex runs a thread search step without tools: %s", (isolationArg) =>
    withFakeCodexEnv(
      { output: THREAD_SEARCH_FINISH_MODEL_OUTPUT, requireArg: isolationArg },
      (textGeneration) =>
        Effect.gen(function* () {
          const step = yield* textGeneration.generateThreadSearchStep({
            ...THREAD_SEARCH_STEP_REQUEST,
            cwd: THREAD_SEARCH_STEP_CWD,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
        }),
    ),
  );

  it.effect("Codex drops launch-arg MCP servers from a thread search step", () =>
    withFakeCodexEnv(
      {
        output: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
        launchArgs: "-c mcp_servers.writer.command=writer-tool -c model_verbosity=low",
        forbidArg: "-c mcp_servers.writer.command=writer-tool",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const step = yield* textGeneration.generateThreadSearchStep({
            ...THREAD_SEARCH_STEP_REQUEST,
            cwd: THREAD_SEARCH_STEP_CWD,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
        }),
    ),
  );

  it.effect("Codex keeps other launch-arg overrides on a thread search step", () =>
    withFakeCodexEnv(
      {
        output: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
        launchArgs: "-c mcp_servers.writer.command=writer-tool -c model_verbosity=low",
        requireArg: "-c model_verbosity=low",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const step = yield* textGeneration.generateThreadSearchStep({
            ...THREAD_SEARCH_STEP_REQUEST,
            cwd: THREAD_SEARCH_STEP_CWD,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
        }),
    ),
  );

  // Guard: other tasks keep the user's full Codex configuration.
  it.effect("keeps launch-arg MCP servers for existing Codex text generation tasks", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Configured title" }),
        launchArgs: "-c mcp_servers.writer.command=writer-tool",
        requireArg: "-c mcp_servers.writer.command=writer-tool",
        forbidArg: "--ignore-user-config",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(generated.title).toBe("Configured title");
        }),
    ),
  );

  it.effect.each([
    "--config=mcp_servers.writer.command=writer-tool",
    "-c=mcp_servers.writer.command=writer-tool",
    "--config mcp_servers.writer.enabled=true",
  ])("Codex drops the launch-arg MCP override %s from a thread search step", (inlineOverride) =>
    withFakeCodexEnv(
      {
        output: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
        launchArgs: inlineOverride,
        forbidArg: inlineOverride,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const step = yield* textGeneration.generateThreadSearchStep({
            ...THREAD_SEARCH_STEP_REQUEST,
            cwd: THREAD_SEARCH_STEP_CWD,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
        }),
    ),
  );

  // Real Codex reports `tools.view_image` as ignored and keeps the tool; the
  // search step must not rely on that override.
  it.effect("Codex does not rely on the ignored tools.view_image override for search", () =>
    withFakeCodexEnv(
      { output: THREAD_SEARCH_FINISH_MODEL_OUTPUT, forbidArg: "--config tools.view_image=false" },
      (textGeneration) =>
        Effect.gen(function* () {
          const step = yield* textGeneration.generateThreadSearchStep({
            ...THREAD_SEARCH_STEP_REQUEST,
            cwd: THREAD_SEARCH_STEP_CWD,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
        }),
    ),
  );

  // Hostile launch args try to relax each protection a search step pins. The
  // step must still resolve to a read-only sandbox, never-approve policy, and
  // no image tool: real codex-cli 0.156.0 then rejected every patch and
  // refused view_image through a local Responses endpoint.
  it.effect.each([
    ["sandbox", "-c sandbox_mode=danger-full-access"],
    ["approval", "-c approval_policy=on-request"],
    ["image tool", "--enable view_image -c features.view_image=true"],
    [
      "all at once",
      '--config=sandbox_mode="workspace-write" -c approval_policy=untrusted --enable view_image',
    ],
  ] as const)(
    "Codex keeps thread search isolation against hostile launch args: %s",
    ([_label, hostileLaunchArgs]) =>
      withFakeCodexEnv(
        {
          output: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
          launchArgs: hostileLaunchArgs,
          requireEffectiveConfig: { sandbox_mode: "read-only", approval_policy: "never" },
          requireDisabledFeatures: ["view_image", "shell_tool"],
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const step = yield* textGeneration.generateThreadSearchStep({
              ...THREAD_SEARCH_STEP_REQUEST,
              cwd: THREAD_SEARCH_STEP_CWD,
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);
          }),
      ),
  );

  // Guard: the fixture itself sees hostile values when nothing overrides them,
  // so the isolation assertions above cannot pass vacuously.
  it.effect("keeps hostile Codex launch args on existing text generation tasks", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Hostile config title" }),
        launchArgs: "-c sandbox_mode=danger-full-access",
        requireEffectiveConfig: { sandbox_mode: "danger-full-access" },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(generated.title).toBe("Hostile config title");
        }),
    ),
  );
  // Mesura: Luna project icon search, the Codex instance's `selectProjectIcon`.
  it.effect("Codex reports Luna icon search unavailable without the Luna model", () =>
    withFakeCodexEnv({ output: "{}", exitCode: 99, models: ["gpt-5.4-mini"] }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* textGeneration
          .selectProjectIcon(ProviderInstanceId.make("codex"), {
            project: { id: ProjectId.make("icon"), title: "Icon", workspaceRoot: process.cwd() },
            candidates: [],
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ProjectIconSelectionUnavailable");
      }),
    ),
  );

  const PROJECT_ICON_MODEL_OUTPUT = JSON.stringify({
    path: "public/brand-logo.png",
    reason: "Brand mark.",
  });
  it.effect.each([
    `--model ${DEFAULT_TEXT_GENERATION_MODEL}`,
    "--ignore-user-config",
    "--disable shell_tool",
    "-s read-only",
  ])("Codex selects a project icon with Luna and %s", (requiredArg) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-icon-" });
      yield* fs.makeDirectory(path.join(root, "public"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "public/brand-logo.png"), "png");
      yield* fs.writeFileString(path.join(root, "public/mark.svg"), "<svg id='brand-mark'/>");
      return yield* withFakeCodexEnv(
        {
          output: PROJECT_ICON_MODEL_OUTPUT,
          models: [DEFAULT_TEXT_GENERATION_MODEL],
          requireArg: requiredArg,
          requireImage: true,
          requireReasoningEffort: "low",
          stdinMustContain: "brand-mark",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const selection = yield* textGeneration.selectProjectIcon(
              ProviderInstanceId.make("codex"),
              {
                project: { id: ProjectId.make("icon"), title: "Icon", workspaceRoot: root },
                candidates: [
                  { path: "public/brand-logo.png", bytes: 3 },
                  { path: "public/mark.svg", bytes: 22 },
                ],
              },
            );
            expect(selection).toEqual({ path: "public/brand-logo.png", reason: "Brand mark." });
          }),
      );
    }).pipe(Effect.scoped),
  );
});
