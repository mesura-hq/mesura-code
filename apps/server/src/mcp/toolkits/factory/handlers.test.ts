// Entry point: the `present_plan` tool, driven through `FactoryToolkit.handle` with the real
// snapshot store and, for registration, through the MCP server that `McpHttpServer` serves.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/unstable/ai";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import * as FactorySnapshotStore from "../../../factory/FactorySnapshotStore.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FactoryToolkitHandlersLive } from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-1");
const ONE_MIB = 1024 * 1024;
const BODY_SENTENCE = "This sentence lives only in the body of the plan.";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const sha256Hex = (data: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const thread: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

/** A plan in the heading contract; `acceptance` sets how many criteria each phase has. */
function planMarkdown(acceptance: ReadonlyArray<number> = [3, 1]): string {
  const phases = acceptance.map((count, index) => ({
    title: `Phase ${index + 1}`,
    goal: `Goal ${index + 1}.`,
    files: [`file-${index + 1}.ts`],
    acceptance: Array.from({ length: count }, (_, criterion) => `Criterion ${criterion + 1}`),
    detail: `Detail ${index + 1}.`,
  }));
  return [
    "# A synthetic plan for the toolkit",
    "",
    "## Context",
    "",
    BODY_SENTENCE,
    "",
    "## A heading no contract knows",
    "",
    "Still a section.",
    "",
    "## The phases",
    "",
    "```json",
    JSON.stringify(phases, null, 2),
    "```",
    "",
    "## Decisions",
    "",
    "Decided.",
    "",
  ].join("\n");
}

const INTENT_MARKDOWN = "# Intent\n\nWhat the developer agreed to.\n";

/** The synthetic plan with `count` extra sections whose headings are `length` characters long. */
function planWithExtraHeadings(count: number, length: number): string {
  const extra = Array.from(
    { length: count },
    (_, index) => `## ${`Heading ${index} `.padEnd(length, "x")}\n\nBody.\n`,
  ).join("\n");
  return planMarkdown().replace("## Decisions", `${extra}\n## Decisions`);
}

// This repository's own plan, as the planning skill wrote it.
const FACTORY_IN_CHAT_PLAN_PATH = new URL(
  "../../../../../../packages/shared/src/fixtures/factory-in-chat.plan.md",
  import.meta.url,
).pathname;

const PLAN_HEADINGS = ["Context", "A heading no contract knows", "The phases", "Decisions"];

const makeHarness = Effect.fn("makeFactoryToolkitHarness")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
  ).pipe(
    Layer.provideMerge(FactorySnapshotStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-toolkit-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  // Built once, so the handlers and the assertions share one snapshots directory.
  const context = yield* Layer.build(dependencies);
  const toolkit = yield* FactoryToolkit.pipe(
    Effect.provide(FactoryToolkitHandlersLive),
    Effect.provide(context),
  );
  const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(context));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const documentsDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-factory-toolkit-documents-",
  });

  const writeDocument = (name: string, contents: string | Uint8Array) =>
    Effect.gen(function* () {
      const documentPath = path.join(documentsDir, name);
      yield* typeof contents === "string"
        ? fileSystem.writeFileString(documentPath, contents)
        : fileSystem.writeFile(documentPath, contents);
      return documentPath;
    });

  const presentPlan = (
    params: { readonly planPath: string; readonly intentPath: string },
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests", "factory"],
  ) =>
    toolkit.handle("present_plan", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<(typeof FactoryToolkit.tools)["present_plan"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(context),
    );

  /** Every snapshot on disk with its inode and modification time, so a rewrite shows. */
  const listSnapshots = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(config.factorySnapshotsDir);
    if (!exists) return [];
    const names = (yield* fileSystem.readDirectory(config.factorySnapshotsDir)).toSorted();
    const entries: Array<{ name: string; ino: number | undefined; mtime: number | undefined }> = [];
    for (const name of names) {
      const info = yield* fileSystem.stat(path.join(config.factorySnapshotsDir, name));
      entries.push({
        name,
        ino: Option.getOrUndefined(info.ino),
        mtime: Option.getOrUndefined(info.mtime)?.getTime(),
      });
    }
    return entries;
  });

  const appendedActivities = Ref.get(commands).pipe(
    Effect.map((recorded) =>
      recorded.flatMap((command) =>
        command.type === "thread.activity.append" ? [command.activity] : [],
      ),
    ),
  );

  return {
    commands,
    config,
    context,
    documentsDir,
    appendedActivities,
    listSnapshots,
    presentPlan,
    writeDocument,
  };
});

it.layer(NodeServices.layer)("factory toolkit present_plan", (it) => {
  it.effect("present_plan returns the plan's sha256 digest, its title and its phase count", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const plan = planMarkdown([3, 1]);
      const planPath = yield* harness.writeDocument("plan.md", plan);
      const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

      const result = yield* harness.presentPlan({ planPath, intentPath });

      expect(result).toMatchObject({
        digest: sha256Hex(plan),
        title: "A synthetic plan for the toolkit",
        phaseCount: 2,
      });
    }),
  );

  it.effect("present_plan stores both files by sha256 and writes nothing new the second time", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const plan = planMarkdown();
      const planPath = yield* harness.writeDocument("plan.md", plan);
      const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

      yield* harness.presentPlan({ planPath, intentPath });
      const afterFirst = yield* harness.listSnapshots;

      expect(afterFirst.map((entry) => entry.name)).toEqual(
        [sha256Hex(plan), sha256Hex(INTENT_MARKDOWN)].toSorted(),
      );
      expect(
        yield* fileSystem.readFileString(
          path.join(harness.config.factorySnapshotsDir, sha256Hex(plan)),
        ),
      ).toBe(plan);
      expect(
        yield* fileSystem.readFileString(
          path.join(harness.config.factorySnapshotsDir, sha256Hex(INTENT_MARKDOWN)),
        ),
      ).toBe(INTENT_MARKDOWN);

      yield* harness.presentPlan({ planPath, intentPath });

      expect(yield* harness.listSnapshots).toEqual(afterFirst);
    }),
  );

  it.effect("present_plan appends one factory.plan activity that carries no document body", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const plan = planMarkdown([3, 1]);
      const planPath = yield* harness.writeDocument("plan.md", plan);
      const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

      yield* harness.presentPlan({ planPath, intentPath });

      const commands = yield* Ref.get(harness.commands);
      expect(commands).toHaveLength(1);
      const [command] = commands;
      expect(command).toMatchObject({ type: "thread.activity.append", threadId: THREAD_ID });
      expect(command?.commandId).toMatch(new RegExp(`^server:factory-plan:${THREAD_ID}:.+`));
      const [activity] = yield* harness.appendedActivities;
      expect(activity).toEqual({
        id: `factory-plan:${THREAD_ID}:${sha256Hex(planPath).slice(0, 16)}`,
        tone: "info",
        kind: "factory.plan",
        summary: "Plan: A synthetic plan for the toolkit",
        payload: {
          digest: sha256Hex(plan),
          intentDigest: sha256Hex(INTENT_MARKDOWN),
          planPath,
          intentPath,
          title: "A synthetic plan for the toolkit",
          phases: [
            { title: "Phase 1", acceptanceCount: 3 },
            { title: "Phase 2", acceptanceCount: 1 },
          ],
          headings: PLAN_HEADINGS,
          presentedAt: expect.any(String),
        },
        turnId: null,
        createdAt: expect.any(String),
      });
      const commandJson = encodeJson(command);
      expect(commandJson).not.toContain(BODY_SENTENCE);
      expect(commandJson).not.toContain("What the developer agreed to.");
    }),
  );

  it.effect("present_plan strips one leading Plan: from the title in the activity summary", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const plan = planMarkdown().replace(
        "# A synthetic plan for the toolkit",
        "# Plan: something worth building",
      );
      const planPath = yield* harness.writeDocument("plan.md", plan);
      const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

      const result = yield* harness.presentPlan({ planPath, intentPath });

      const [activity] = yield* harness.appendedActivities;
      expect(result.title).toBe("Plan: something worth building");
      expect(activity?.summary).toBe("Plan: something worth building");
      expect(activity?.payload).toMatchObject({ title: "Plan: something worth building" });
    }),
  );

  it.effect("present_plan replaces the activity of an edited plan in place and moves it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const planPath = yield* harness.writeDocument("plan.md", planMarkdown([3, 1]));
      const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);
      yield* harness.presentPlan({ planPath, intentPath });

      const edited = planMarkdown([3, 2, 4]);
      yield* harness.writeDocument("plan.md", edited);
      yield* TestClock.adjust("1 minute");
      const result = yield* harness.presentPlan({ planPath, intentPath });

      const [first, second] = yield* harness.appendedActivities;
      expect(result).toMatchObject({ digest: sha256Hex(edited), phaseCount: 3 });
      expect(second?.id).toBe(first?.id);
      expect(second?.payload).toMatchObject({ digest: sha256Hex(edited) });
      expect(first?.payload).not.toMatchObject({ digest: sha256Hex(edited) });
      expect(Date.parse(second!.createdAt)).toBeGreaterThan(Date.parse(first!.createdAt));

      const otherPlanPath = yield* harness.writeDocument("other-plan.md", planMarkdown([1]));
      yield* harness.presentPlan({ planPath: otherPlanPath, intentPath });
      const activities = yield* harness.appendedActivities;
      expect(new Set(activities.map((activity) => activity.id)).size).toBe(2);
    }),
  );

  describe("present_plan refusals", () => {
    const refuses = (
      name: string,
      prepare: (harness: Effect.Success<ReturnType<typeof makeHarness>>) => Effect.Effect<
        {
          readonly params: { readonly planPath: string; readonly intentPath: string };
          readonly reason: string;
          readonly names: string;
          readonly cause: RegExp;
        },
        PlatformError.PlatformError,
        Path.Path
      >,
    ) =>
      it.effect(name, () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const { params, reason, names, cause } = yield* prepare(harness);

          const error = yield* harness.presentPlan(params).pipe(Effect.flip);

          expect(error).toMatchObject({ _tag: "FactoryPresentPlanError", reason });
          expect(error.message).toContain(names);
          expect(error.message).toMatch(cause);
          expect(yield* Ref.get(harness.commands)).toEqual([]);
        }),
      );

    refuses("present_plan refuses a relative plan path and records no activity", (harness) =>
      Effect.gen(function* () {
        const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);
        yield* harness.writeDocument("plan.md", planMarkdown());
        return {
          params: { planPath: "plan.md", intentPath },
          reason: "relative-path",
          names: "plan.md",
          cause: /absolute/i,
        };
      }),
    );

    refuses("present_plan refuses a relative intent path and records no activity", (harness) =>
      Effect.gen(function* () {
        const planPath = yield* harness.writeDocument("plan.md", planMarkdown());
        return {
          params: { planPath, intentPath: "../intent.md" },
          reason: "relative-path",
          names: "../intent.md",
          cause: /absolute/i,
        };
      }),
    );

    refuses("present_plan refuses a missing plan file and records no activity", (harness) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);
        const planPath = path.join(harness.documentsDir, "missing-plan.md");
        return {
          params: { planPath, intentPath },
          reason: "not-found",
          names: planPath,
          cause: /not found|does not exist|no such file/i,
        };
      }),
    );

    refuses("present_plan refuses a missing intent file and records no activity", (harness) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const planPath = yield* harness.writeDocument("plan.md", planMarkdown());
        const intentPath = path.join(harness.documentsDir, "missing-intent.md");
        return {
          params: { planPath, intentPath },
          reason: "not-found",
          names: intentPath,
          cause: /not found|does not exist|no such file/i,
        };
      }),
    );

    refuses("present_plan refuses a file over 1 MiB and records no activity", (harness) =>
      Effect.gen(function* () {
        const planPath = yield* harness.writeDocument("plan.md", planMarkdown());
        const intentPath = yield* harness.writeDocument(
          "intent.md",
          new Uint8Array(ONE_MIB + 1).fill(0x61),
        );
        return {
          params: { planPath, intentPath },
          reason: "too-large",
          names: intentPath,
          cause: /1 MiB/,
        };
      }),
    );

    refuses("present_plan refuses a plan whose phase block does not parse", (harness) =>
      Effect.gen(function* () {
        const planPath = yield* harness.writeDocument(
          "plan.md",
          planMarkdown().replace(/```json\n[\s\S]*?\n```/, "```json\n[{ not json\n```"),
        );
        const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);
        return {
          params: { planPath, intentPath },
          reason: "invalid-plan",
          names: planPath,
          cause: /phase/i,
        };
      }),
    );

    it.effect("present_plan refuses a directory in place of a file and records no activity", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const planPath = yield* harness.writeDocument("plan.md", planMarkdown());

        const error = yield* harness
          .presentPlan({ planPath, intentPath: harness.documentsDir })
          .pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "FactoryPresentPlanError" });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }),
    );

    it.effect("present_plan refuses a plan whose headings exceed the 16 KiB card budget", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        // 200 headings of 100 bytes: about 20 KiB of metadata in a 22 KiB file.
        const planPath = yield* harness.writeDocument("plan.md", planWithExtraHeadings(200, 100));
        const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

        const error = yield* harness.presentPlan({ planPath, intentPath }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "FactoryPresentPlanError",
          reason: "metadata-too-large",
        });
        expect(error.message).toContain(planPath);
        expect(error.message).toContain("16 KiB");
        expect(yield* Ref.get(harness.commands)).toEqual([]);
        expect(yield* harness.listSnapshots).toEqual([]);
      }),
    );

    it.effect("present_plan keeps every heading of a plan just within the card budget", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        // 150 headings of 100 bytes: about 15 KiB of metadata.
        const planPath = yield* harness.writeDocument("plan.md", planWithExtraHeadings(150, 100));
        const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

        yield* harness.presentPlan({ planPath, intentPath });

        const [activity] = yield* harness.appendedActivities;
        const payload = activity?.payload as { readonly headings: ReadonlyArray<string> };
        expect(payload.headings).toHaveLength(PLAN_HEADINGS.length + 150);
        expect(payload.headings[0]).toBe("Context");
        expect(payload.headings.at(-1)).toBe("Decisions");
      }),
    );

    it.effect("present_plan accepts a file of exactly 1 MiB", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const planPath = yield* harness.writeDocument("plan.md", planMarkdown());
        const intentPath = yield* harness.writeDocument(
          "intent.md",
          new Uint8Array(ONE_MIB).fill(0x61),
        );

        yield* harness.presentPlan({ planPath, intentPath });

        expect(yield* harness.appendedActivities).toHaveLength(1);
      }),
    );
  });

  it.effect(
    "present_plan presents this repository's own plan with all its headings and phases",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const plan = yield* fileSystem.readFile(FACTORY_IN_CHAT_PLAN_PATH);
        const planPath = yield* harness.writeDocument("plan.md", plan);
        const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

        const result = yield* harness.presentPlan({ planPath, intentPath });

        const [activity] = yield* harness.appendedActivities;
        expect(result).toMatchObject({
          digest: sha256Hex(plan),
          title: "Plan: the Software Factory inside Mesura Code",
          phaseCount: 11,
        });
        expect(activity?.summary).toBe("Plan: the Software Factory inside Mesura Code");
        expect(activity?.payload).toMatchObject({
          headings: [
            "Context",
            "Current state",
            "What we will build",
            "What we will NOT build",
            "The design we agreed",
            "How, in outline",
            "Done when",
            "The phases",
            "Architecture",
            "Open questions",
            "Risks",
            "Decisions",
            "What I read before planning",
          ],
        });
        const phases = (
          activity?.payload as { readonly phases: ReadonlyArray<unknown> } | undefined
        )?.phases;
        expect(phases).toHaveLength(11);
        expect(phases?.[0]).toEqual({
          title: "Snapshot a plan and present it to the thread",
          acceptanceCount: 8,
        });
      }),
  );

  it.effect("present_plan refuses a credential without the factory capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const planPath = yield* harness.writeDocument("plan.md", planMarkdown());
      const intentPath = yield* harness.writeDocument("intent.md", INTENT_MARKDOWN);

      const error = yield* harness
        .presentPlan({ planPath, intentPath }, ["pull-requests", "preview", "device"])
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "factory",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(yield* harness.listSnapshots).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("factory toolkit registration", (it) => {
  it.effect("McpHttpServer registers present_plan and surfaces a missing factory capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registration = McpHttpServer.FactoryToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.succeedContext(harness.context)),
      );
      const server = yield* McpServer.McpServer.pipe(Effect.provide(registration));

      const presentPlan = server.tools.find(({ tool }) => tool.name === "present_plan");
      expect(presentPlan?.tool.annotations?.readOnlyHint).toBe(false);
      expect(presentPlan?.tool.annotations?.idempotentHint).toBe(true);

      const denied = yield* server
        .callTool({
          name: "present_plan",
          arguments: { planPath: "/tmp/plan.md", intentPath: "/tmp/intent.md" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["preview"])),
          Effect.provideService(
            McpSchema.McpServerClient,
            McpSchema.McpServerClient.of({
              clientId: 1,
              clientCapabilities: {},
              clientInfo: { name: "factory-test", version: "1.0.0" },
              protocolVersion: "2025-06-18",
              initializePayload: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "factory-test", version: "1.0.0" },
              },
              getClient: Effect.die("unused"),
            }),
          ),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the factory capability." },
      ]);
    }),
  );
});
