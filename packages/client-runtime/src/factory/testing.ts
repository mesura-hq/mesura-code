/**
 * Test data for the Factory plan specs on every client: `factory.plan`
 * activities as the server's `present_plan` handler writes them. Each test
 * reads the plan fixture itself, since web, mobile and this package load a
 * file differently.
 */
import {
  EventId,
  FACTORY_PLAN_ACTIVITY_KIND,
  ProviderDriverKind,
  ProviderInstanceId,
  type FactoryPlanActivityPayload,
  type OrchestrationThreadActivity,
  type ServerProvider,
  type ServerProviderModel,
  type TurnId,
} from "@t3tools/contracts";

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
