/**
 * Test data for the Factory specs on every client: `factory.plan` activities
 * as the server's `present_plan` handler writes them, and `factory.run`
 * activities as its run tracker writes them. Each test reads the plan and
 * events fixtures itself, since web, mobile and this package load a file
 * differently.
 */
import {
  EventId,
  FACTORY_PLAN_ACTIVITY_KIND,
  FACTORY_RUN_ACTIVITY_KIND,
  factoryRunActivityId,
  ProviderDriverKind,
  ProviderInstanceId,
  type FactoryPlanActivityPayload,
  type FactoryRunState,
  type FactoryRunSummary,
  type OrchestrationThreadActivity,
  type ServerProvider,
  type ServerProviderModel,
  type TurnId,
} from "@t3tools/contracts";
import {
  emptyFactoryRunState,
  foldFactoryRunLine,
  summarizeFactoryRun,
} from "@t3tools/shared/factoryRun";

import type { FactoryRoutes } from "./routes.ts";

export const FACTORY_PLAN_DIGEST = "a".repeat(64);
export const FACTORY_INTENT_DIGEST = "b".repeat(64);
export const FACTORY_REVISED_PLAN_DIGEST = "c".repeat(64);
export const FACTORY_OTHER_PLAN_DIGEST = "d".repeat(64);

export function makeFactoryPlanPayload(
  overrides: Partial<FactoryPlanActivityPayload> = {},
): FactoryPlanActivityPayload {
  return {
    digest: FACTORY_PLAN_DIGEST,
    intentDigest: FACTORY_INTENT_DIGEST,
    planPath: "/home/dev/plans/factory-in-chat/plan.md",
    intentPath: "/home/dev/plans/factory-in-chat/intent.md",
    title: "Plan: the Software Factory inside Mesura Code",
    phases: [
      { title: "Snapshot a plan and present it to the thread", acceptanceCount: 7 },
      { title: "Render the plan card and the Factory pane on the web", acceptanceCount: 6 },
    ],
    headings: ["Context", "The phases", "Architecture", "Decisions"],
    presentedAt: "2026-09-28T10:00:05.000Z",
    ...overrides,
  };
}

/** One activity per plan file: the server derives the id from the path, never the bytes. */
export function makeFactoryPlanActivity(input: {
  readonly id?: string;
  readonly createdAt: string;
  readonly turnId?: TurnId | null;
  readonly payload?: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id ?? "factory-plan:plan-md"),
    tone: "info",
    kind: FACTORY_PLAN_ACTIVITY_KIND,
    summary: "Presented a plan",
    payload: input.payload ?? makeFactoryPlanPayload({ presentedAt: input.createdAt }),
    turnId: input.turnId ?? null,
    createdAt: input.createdAt,
  };
}

// Route picker test data: the provider model lists the server sends, shaped as
// this machine's manifest listed them on 2026-09-28. Claude names its level
// option `effort`, Codex `reasoningEffort` (`CodexProvider.ts`).

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"];
const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

export interface FactoryTestModel {
  readonly slug: string;
  readonly name: string;
  readonly isLegacy?: boolean;
  /** Level ids in the provider's order; omitted means the family's usual list. */
  readonly levels?: ReadonlyArray<string>;
  /** Levels the provider sends as prompt text rather than a harness effort. */
  readonly promptInjectedLevels?: ReadonlyArray<string>;
}

function makeFactoryTestModel(
  model: FactoryTestModel,
  descriptorId: "effort" | "reasoningEffort",
  defaultLevels: ReadonlyArray<string>,
  defaultPromptInjected: ReadonlyArray<string>,
): ServerProviderModel {
  const levels = model.levels ?? defaultLevels;
  const promptInjected = (model.promptInjectedLevels ?? defaultPromptInjected).filter((level) =>
    levels.includes(level),
  );
  return {
    slug: model.slug,
    name: model.name,
    isCustom: false,
    ...(model.isLegacy === undefined ? {} : { isLegacy: model.isLegacy }),
    capabilities: {
      optionDescriptors:
        levels.length === 0
          ? []
          : [
              {
                id: descriptorId,
                label: "Reasoning",
                type: "select",
                options: levels.map((level) => ({
                  id: level,
                  label: EFFORT_LABELS[level] ?? level,
                  ...(level === "medium" ? { isDefault: true } : {}),
                })),
                ...(promptInjected.length > 0 ? { promptInjectedValues: promptInjected } : {}),
              },
            ],
    },
  };
}

export const FACTORY_CLAUDE_TEST_MODELS: ReadonlyArray<FactoryTestModel> = [
  { slug: "claude-opus-5", name: "Claude Opus 5" },
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { slug: "claude-opus-6", name: "Claude Opus 6 (legacy)", isLegacy: true },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
];

export const FACTORY_CODEX_TEST_MODELS: ReadonlyArray<FactoryTestModel> = [
  { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { slug: "gpt-6-luna", name: "GPT-6 Luna" },
  { slug: "gpt-6-sol", name: "GPT-6 Sol" },
  { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { slug: "gpt-6-astra", name: "GPT-6 Astra" },
];

function makeFactoryTestProvider(
  driver: "claudeAgent" | "codex",
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T10:00:00.000Z",
    models: [...models],
    slashCommands: [],
    skills: [],
  };
}

/**
 * A Claude and a Codex provider with the given model lists. Pass `null` to
 * leave a provider out, as a server without it installed would.
 */
export function makeFactoryRouteProviders(
  input: {
    readonly claude?: ReadonlyArray<FactoryTestModel> | null;
    readonly codex?: ReadonlyArray<FactoryTestModel> | null;
    /** Fields to replace on a provider, such as `enabled` or `instanceId`. */
    readonly claudeProvider?: Partial<ServerProvider>;
    readonly codexProvider?: Partial<ServerProvider>;
  } = {},
): ReadonlyArray<ServerProvider> {
  const claude = input.claude === undefined ? FACTORY_CLAUDE_TEST_MODELS : input.claude;
  const codex = input.codex === undefined ? FACTORY_CODEX_TEST_MODELS : input.codex;
  const providers: ServerProvider[] = [];
  if (claude !== null) {
    providers.push({
      ...makeFactoryTestProvider(
        "claudeAgent",
        claude.map((model) =>
          makeFactoryTestModel(model, "effort", CLAUDE_EFFORT_LEVELS, ["ultrathink"]),
        ),
      ),
      ...input.claudeProvider,
    });
  }
  if (codex !== null) {
    providers.push({
      ...makeFactoryTestProvider(
        "codex",
        codex.map((model) =>
          makeFactoryTestModel(model, "reasoningEffort", CODEX_EFFORT_LEVELS, []),
        ),
      ),
      ...input.codexProvider,
    });
  }
  return providers;
}

/** The routes the card offers by default for `makeFactoryRouteProviders()`. */
export const FACTORY_DEFAULT_TEST_ROUTES: FactoryRoutes = {
  implementer: { harness: "claude", model: "claude-opus-5-5", effort: "high", budgetUsd: 25 },
  reviewer: { harness: "codex", model: "gpt-6-sol", effort: "high" },
  verifier: { harness: "codex", model: "gpt-6-luna", effort: "max" },
};

/**
 * An Approve message as the plan defines it, written out literally so a spec
 * never builds its expectation with the code under test.
 */
export function writeFactoryApprovalMessage(input: {
  readonly digest: string;
  readonly planPath: string;
  readonly intentPath: string;
  readonly routes: FactoryRoutes;
}): string {
  return [
    `Approve plan sha256:${input.digest}`,
    `Plan: ${input.planPath}`,
    `Intent: ${input.intentPath}`,
    "Build it with sf-team in this thread, with these routes:",
    "```json",
    JSON.stringify(input.routes, null, 2),
    "```",
  ].join("\n");
}

/** The first line and the routes block of a sent Approve message. */
export function readFactoryApprovalMessage(text: string): {
  readonly firstLine: string;
  readonly routes: unknown;
} {
  const fence = /```json\n([\s\S]*?)\n```/.exec(text);
  return {
    firstLine: text.split("\n")[0] ?? "",
    routes: fence?.[1] === undefined ? null : JSON.parse(fence[1]),
  };
}

// Run card test data: `factory.run` activities as the server's run tracker
// writes them, folded from the recorder's fixture
// (`packages/shared/src/fixtures/factory-events.v1.jsonl`, a two-phase run).
// Each test reads the fixture itself and passes its text in.

export const FACTORY_RUN_TEST_DIR = "/srv/factory-runs/invoice-csv-export";

/**
 * A point in the fixture run:
 * - `attached`: attached before any event, the provisional activity;
 * - `framed`: started and framed, no phase yet;
 * - `verify`: phase 1 at `verify-1`, one return used, $10.03 spent;
 * - `review`: phase 1 at `review`, the next event after `verify`'s verdict;
 * - `waiting`: phase 2 stopped at a question;
 * - `answered`: the question answered, phase 2 running again;
 * - `degraded`: finished with phase 2 closed degraded (the fixture's end);
 * - `done`: finished with both phases clean;
 * - `stopped`: finished by the coordinator after the answer.
 */
export type FactoryRunFixturePoint =
  | "attached"
  | "framed"
  | "verify"
  | "review"
  | "waiting"
  | "answered"
  | "degraded"
  | "done"
  | "stopped";

function factoryRunFixtureLines(jsonl: string, point: FactoryRunFixturePoint): string[] {
  const lines = jsonl.split("\n").filter((line) => line.trim().length > 0);
  switch (point) {
    case "attached":
      return [];
    case "framed":
      return lines.slice(0, 3);
    case "verify":
      return lines.slice(0, 19);
    case "review":
      return lines.slice(0, 23);
    case "waiting":
      return lines.slice(0, 53);
    case "answered":
      return lines.slice(0, 54);
    case "degraded":
      return lines;
    case "done":
      return [
        ...lines.slice(0, 71),
        '{"v":1,"at":"2026-09-28T13:43:00.000Z","type":"phase.closed","phase":2,"close":"clean"}',
        '{"v":1,"at":"2026-09-28T13:49:00.000Z","type":"run.finished","status":"done"}',
      ];
    case "stopped":
      return [
        ...lines.slice(0, 54),
        '{"v":1,"at":"2026-09-28T13:00:00.000Z","type":"run.finished","status":"stopped"}',
      ];
  }
}

/** The full state the run tracker folds at one point of the fixture run. */
export function makeFactoryRunState(jsonl: string, point: FactoryRunFixturePoint): FactoryRunState {
  return foldFactoryRunTestLines(factoryRunFixtureLines(jsonl, point));
}

/** Folds event lines as the run tracker does, for states the fixture does not reach. */
export function foldFactoryRunTestLines(lines: ReadonlyArray<string>): FactoryRunState {
  let state = emptyFactoryRunState(FACTORY_RUN_TEST_DIR);
  for (const line of lines) state = foldFactoryRunLine(state, line);
  return state;
}

/** The compact summary the run tracker publishes at one point of the fixture run. */
export function makeFactoryRunSummary(
  jsonl: string,
  point: FactoryRunFixturePoint,
): FactoryRunSummary {
  return summarizeFactoryRun(makeFactoryRunState(jsonl, point));
}

/**
 * The summary the tracker publishes for a run too long to carry its phase
 * marks (`summarizeFactoryRun` drops them last), or one stored before the
 * field existed.
 */
export function withoutFactoryRunMarks(summary: FactoryRunSummary): FactoryRunSummary {
  const { phaseStatuses: _marks, ...rest } = summary;
  return rest;
}

/** One activity per run, replaced in place: the tracker derives the id from thread and run. */
export function makeFactoryRunActivity(input: {
  readonly threadId: string;
  readonly summary: FactoryRunSummary;
  /** Defaults to the tracker's choice: the run's start, else the attach time. */
  readonly createdAt?: string;
  readonly turnId?: TurnId | null;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(factoryRunActivityId(input.threadId, input.summary.runId)),
    tone: "info",
    kind: FACTORY_RUN_ACTIVITY_KIND,
    summary: "Software Factory run",
    payload: { threadId: input.threadId, ...input.summary },
    turnId: input.turnId ?? null,
    createdAt: input.createdAt ?? input.summary.startedAt ?? "2026-09-28T08:59:00.000Z",
  };
}
