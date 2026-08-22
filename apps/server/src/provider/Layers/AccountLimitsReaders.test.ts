import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { readClaudeAccountLimitsWithQuery } from "./ClaudeProvider.ts";
import { buildCodexAppServerCommand, requestCodexAccountLimits } from "./CodexProvider.ts";

describe("Claude account-limit reader", () => {
  it.effect("uses a no-prompt control query and always aborts it", () =>
    Effect.gen(function* () {
      let capturedInput: unknown;
      let aborted = false;
      const result = yield* readClaudeAccountLimitsWithQuery({
        executablePath: "/usr/bin/claude",
        environment: { HOME: "/home/claude-work", ACCOUNT_MARKER: "work" },
        cwd: "/workspace/work",
        extraArgs: { "account-marker": "work" },
        queryFactory: (input) => {
          capturedInput = input;
          input.options?.abortController?.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return {
            initializationResult: async () => ({ account: { subscriptionType: "max" } }),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              subscription_type: "max",
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 12, resets_at: "2026-08-22T18:00:00.000Z" },
              },
            }),
          };
        },
      });

      const input = capturedInput as {
        readonly prompt: AsyncIterable<unknown>;
        readonly options: {
          readonly cwd?: string;
          readonly env?: NodeJS.ProcessEnv;
          readonly allowedTools?: ReadonlyArray<string>;
          readonly persistSession?: boolean;
          readonly extraArgs?: Record<string, string | null>;
          readonly pathToClaudeCodeExecutable?: string;
        };
      };
      assert.equal((result as { readonly subscription_type?: string }).subscription_type, "max");
      assert.equal(input.options.cwd, "/workspace/work");
      assert.equal(input.options.env?.HOME, "/home/claude-work");
      assert.equal(input.options.env?.ACCOUNT_MARKER, "work");
      assert.deepEqual(input.options.allowedTools, []);
      assert.equal(input.options.persistSession, false);
      assert.deepEqual(input.options.extraArgs, { "account-marker": "work" });
      assert.equal(input.options.pathToClaudeCodeExecutable, "/usr/bin/claude");
      assert.equal(aborted, true);
      assert.equal(Symbol.asyncIterator in input.prompt, true);
    }),
  );

  it.effect("times out and aborts a stuck usage request", () =>
    Effect.gen(function* () {
      let aborted = false;
      const fiber = yield* readClaudeAccountLimitsWithQuery({
        executablePath: "/usr/bin/claude",
        environment: { HOME: "/home/claude" },
        cwd: "/workspace",
        timeout: "1 second",
        queryFactory: (input) => {
          input.options?.abortController?.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return {
            initializationResult: async () => ({}),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
              new Promise<never>(() => {}),
          };
        },
      }).pipe(Effect.exit, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.join(fiber);
      assert.equal(Exit.isFailure(exit), true);
      assert.equal(aborted, true);
    }),
  );
});

describe("Codex account-limit reader", () => {
  it.effect("keeps launch configuration isolated per account", () =>
    Effect.gen(function* () {
      const personal = yield* buildCodexAppServerCommand({
        binaryPath: "/opt/codex-personal",
        homePath: "/home/user/.codex-personal",
        launchArgs: "--enable personal-feature",
        cwd: "/workspace/personal",
        environment: { ACCOUNT_MARKER: "personal" },
      });
      const work = yield* buildCodexAppServerCommand({
        binaryPath: "/opt/codex-work",
        homePath: "/home/user/.codex-work",
        launchArgs: "--enable work-feature",
        cwd: "/workspace/work",
        environment: { ACCOUNT_MARKER: "work" },
      });

      assert.equal(personal.command, "/opt/codex-personal");
      assert.equal(work.command, "/opt/codex-work");
      assert.equal(personal.args.includes("personal-feature"), true);
      assert.equal(work.args.includes("work-feature"), true);
      assert.equal(personal.options.env?.CODEX_HOME, "/home/user/.codex-personal");
      assert.equal(work.options.env?.CODEX_HOME, "/home/user/.codex-work");
      assert.equal(personal.options.env?.ACCOUNT_MARKER, "personal");
      assert.equal(work.options.env?.ACCOUNT_MARKER, "work");
      assert.equal(personal.options.cwd, "/workspace/personal");
      assert.equal(work.options.cwd, "/workspace/work");
    }),
  );

  it.effect("initializes app-server before requesting account limits", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const result = yield* requestCodexAccountLimits({
        initialize: () => {
          calls.push("request:initialize");
          return Effect.succeed({ userAgent: "codex-cli/1.0.0" });
        },
        notifyInitialized: () => {
          calls.push("notify:initialized");
          return Effect.void;
        },
        readAccountLimits: () => {
          calls.push("request:account/rateLimits/read");
          return Effect.succeed({
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 20, windowDurationMins: 10_080 },
            },
          });
        },
      });

      assert.deepEqual(calls, [
        "request:initialize",
        "notify:initialized",
        "request:account/rateLimits/read",
      ]);
      assert.equal(result.rateLimits.limitId, "codex");
    }),
  );
});
