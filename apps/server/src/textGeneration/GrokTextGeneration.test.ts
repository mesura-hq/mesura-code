// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeProcessProbe } from "../testUtils/processProbe.ts";
import { makeGrokTextGeneration } from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import {
  THREAD_SEARCH_FINISH_MODEL_OUTPUT,
  THREAD_SEARCH_FINISH_STEP,
  THREAD_SEARCH_FORBIDDEN_MODEL_OUTPUT,
  THREAD_SEARCH_STEP_CWD,
  THREAD_SEARCH_STEP_REQUEST,
  THREAD_SEARCH_QUOTED_EXCERPT,
} from "@t3tools/provider-testing/threadSearchStep";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../provider/testFixtures/grok-text-mock-agent.mjs");

const layerGrokTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-grok-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpGrokWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "grok",
    env,
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["agent", "stdio"],
    }),
  });
}

function withFakeAcpGrok<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
  environment?: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpGrokWrapper(tempDir, env);
    const config = decodeGrokSettings({ binaryPath });
    const textGeneration = yield* makeGrokTextGeneration(config, environment);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(layerGrokTextGenerationTest)("GrokTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-grok-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpGrok(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Grok provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/grok",
            stagedSummary: "M apps/server/src/provider/Drivers/GrokDriver.ts",
            stagedPatch: "diff --git a/.../GrokDriver.ts b/.../GrokDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-mock-alt"),
          });

          expect(generated.subject).toBe("Add Grok provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_model" &&
                request.params?.modelId === "grok-mock-alt",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("extracts the JSON object when Grok wraps it in conversational text", () =>
    withFakeAcpGrok(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-mock-alt"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );
  // Agent thread search, phase 2: the step runs with no file or terminal
  // capability and outside the project directory, so Grok's own tools
  // have nothing to read.
  it.effect(
    "Grok answers a schema-checked thread search step without file or terminal access",
    () => {
      const requestLogDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-grok-search-log-"),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

      return withFakeAcpGrok(
        {
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const step = yield* textGeneration.generateThreadSearchStep({
              ...THREAD_SEARCH_STEP_REQUEST,
              cwd: THREAD_SEARCH_STEP_CWD,
              modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-build"),
            });
            expect(step).toEqual(THREAD_SEARCH_FINISH_STEP);

            const requests = readJsonRpcRequests(requestLogPath);
            expect(
              requests.find((request) => request.method === "initialize")?.params
                ?.clientCapabilities,
            ).toMatchObject({
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            });
            const sessionCwd = requests.find((request) => request.method === "session/new")?.params
              ?.cwd;
            expect(typeof sessionCwd).toBe("string");
            expect((sessionCwd as string).startsWith(process.cwd())).toBe(false);
            // The isolated working directory is removed when the step ends.
            expect(NodeFS.existsSync(sessionCwd as string)).toBe(false);
            const promptParts = (requests.find((request) => request.method === "session/prompt")
              ?.params?.prompt ?? []) as ReadonlyArray<{ readonly text?: string }>;
            const promptText = promptParts.map((part) => part.text ?? "").join("");
            expect(promptText).toContain(THREAD_SEARCH_QUOTED_EXCERPT);
          }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(requestLogDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("Grok rejects a write action as a thread search step", () =>
    withFakeAcpGrok(
      { T3_ACP_PROMPT_RESPONSE_TEXT: THREAD_SEARCH_FORBIDDEN_MODEL_OUTPUT },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* textGeneration
            .generateThreadSearchStep({
              ...THREAD_SEARCH_STEP_REQUEST,
              cwd: THREAD_SEARCH_STEP_CWD,
              modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-build"),
            })
            .pipe(Effect.flip);
          expect(error._tag).toBe("TextGenerationError");
          expect(error.operation).toBe("generateThreadSearchStep");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );

  // Review P1-2: Grok keeps every session under $GROK_HOME/sessions; a search
  // step removes the one it created and nothing else.
  const UNRELATED_GROK_SESSION = "%2Fhome%2Fproj/019fd20e-c563-70a0-b801-a6bc51815a9b";
  const makeGrokHome = () => {
    const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-home-"));
    const unrelated = NodePath.join(grokHome, "sessions", UNRELATED_GROK_SESSION);
    NodeFS.mkdirSync(unrelated, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(unrelated, "updates.jsonl"), "{}\n");
    return grokHome;
  };
  // Every session directory under the home, as `<project>/<session>` paths.
  const grokSessionDirectories = (grokHome: string) => {
    const sessions = NodePath.join(grokHome, "sessions");
    return NodeFS.readdirSync(sessions).flatMap((project) =>
      NodeFS.readdirSync(NodePath.join(sessions, project)).map((id) => `${project}/${id}`),
    );
  };
  const withGrokHome = <A, E, R>(
    env: Record<string, string>,
    run: (
      textGeneration: TextGeneration.TextGeneration["Service"],
      grokHome: string,
    ) => Effect.Effect<A, E, R>,
  ) => {
    const grokHome = makeGrokHome();
    return withFakeAcpGrok(
      { T3_ACP_WRITE_GROK_SESSION: "1", ...env },
      (textGeneration) => run(textGeneration, grokHome),
      { ...process.env, GROK_HOME: grokHome },
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(grokHome, { recursive: true, force: true }))),
    );
  };
  const grokSearchStep = (textGeneration: TextGeneration.TextGeneration["Service"]) =>
    textGeneration.generateThreadSearchStep({
      ...THREAD_SEARCH_STEP_REQUEST,
      cwd: THREAD_SEARCH_STEP_CWD,
      modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-build"),
    });

  it.effect("Grok removes its native session after a thread search step", () =>
    withGrokHome({ T3_ACP_PROMPT_RESPONSE_TEXT: THREAD_SEARCH_FINISH_MODEL_OUTPUT }, (tg, home) =>
      Effect.gen(function* () {
        expect(yield* grokSearchStep(tg)).toEqual(THREAD_SEARCH_FINISH_STEP);
        expect(grokSessionDirectories(home)).toEqual([UNRELATED_GROK_SESSION]);
      }),
    ),
  );

  it.effect("Grok removes its native session after invalid thread search output", () =>
    withGrokHome(
      { T3_ACP_PROMPT_RESPONSE_TEXT: THREAD_SEARCH_FORBIDDEN_MODEL_OUTPUT },
      (tg, home) =>
        Effect.gen(function* () {
          const error = yield* grokSearchStep(tg).pipe(Effect.flip);
          expect(error.detail).toMatch(/invalid structured output/i);
          expect(grokSessionDirectories(home)).toEqual([UNRELATED_GROK_SESSION]);
        }),
    ),
  );

  it.effect("Grok removes only its own session from a shared project directory", () =>
    withGrokHome(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: THREAD_SEARCH_FINISH_MODEL_OUTPUT,
        T3_ACP_GROK_SESSION_PROJECT: "%2Fhome%2Fproj",
      },
      (tg, home) =>
        Effect.gen(function* () {
          yield* grokSearchStep(tg);
          expect(grokSessionDirectories(home)).toEqual([UNRELATED_GROK_SESSION]);
        }),
    ),
  );

  it.effect("Grok removes the native session of a cancelled thread search step", () =>
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      yield* withGrokHome(
        {
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_SESSION_PROBE_PORT: String(probe.port),
        },
        (tg, home) =>
          Effect.gen(function* () {
            const step = yield* grokSearchStep(tg).pipe(Effect.forkChild);
            yield* probe.started;
            expect(grokSessionDirectories(home)).toHaveLength(2);

            yield* Fiber.interrupt(step);
            yield* probe.exited;

            expect(grokSessionDirectories(home)).toEqual([UNRELATED_GROK_SESSION]);
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("Grok reports a thread search session it could not remove", () => {
    const grokHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-home-"));
    // A file where the sessions directory belongs: listing it fails.
    NodeFS.writeFileSync(NodePath.join(grokHome, "sessions"), "not a directory");
    return withFakeAcpGrok(
      { T3_ACP_PROMPT_RESPONSE_TEXT: THREAD_SEARCH_FINISH_MODEL_OUTPUT },
      (tg) =>
        Effect.gen(function* () {
          const error = yield* grokSearchStep(tg).pipe(Effect.flip);
          expect(error._tag).toBe("TextGenerationError");
          expect(error.operation).toBe("generateThreadSearchStep");
          expect(error.detail).toMatch(/could not remove/i);
        }),
      { ...process.env, GROK_HOME: grokHome },
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(grokHome, { recursive: true, force: true }))),
    );
  });

  // Guard: other Grok tasks keep their sessions, as before.
  it.effect("keeps Grok native sessions for existing text generation tasks", () =>
    withGrokHome(
      { T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Kept session title" }) },
      (tg, home) =>
        Effect.gen(function* () {
          yield* tg.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: createModelSelection(ProviderInstanceId.make("grok"), "grok-build"),
          });
          expect(grokSessionDirectories(home)).toHaveLength(2);
        }),
    ),
  );
});
