/**
 * The routes a Software Factory run uses: one harness, model and reasoning
 * level per role, chosen on the plan card and sent with Approve. Web and
 * Android both build their route picker from this module, so the defaults and
 * the routing rules exist once.
 *
 * The shape is exactly sf-team's `--routes` file
 * (`~/.agent-env/skills/core/sf-team/ROUTES.md`), and the two rules are its
 * *Frame*: the verifier runs on Codex, and the reviewer runs on the other
 * family from the implementer. No React and no ES2023 array methods: Android
 * runs this on Hermes.
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderOptionChoice,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const FactoryHarness = Schema.Literals(["claude", "codex"]);
export type FactoryHarness = typeof FactoryHarness.Type;

export const FactoryRoute = Schema.Struct({
  harness: FactoryHarness,
  model: Schema.String,
  effort: Schema.String,
  /** Dollars per launch; a Claude implementer carries it, no other role does. */
  budgetUsd: Schema.optionalKey(Schema.Number),
});
export type FactoryRoute = typeof FactoryRoute.Type;

export const FactoryRoutes = Schema.Struct({
  implementer: FactoryRoute,
  reviewer: FactoryRoute,
  verifier: FactoryRoute,
});
export type FactoryRoutes = typeof FactoryRoutes.Type;

export type FactoryRouteRole = keyof FactoryRoutes;
export const FACTORY_ROUTE_ROLES: ReadonlyArray<FactoryRouteRole> = [
  "implementer",
  "reviewer",
  "verifier",
];
export const FACTORY_ROUTE_ROLE_LABELS: Readonly<Record<FactoryRouteRole, string>> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
  verifier: "Verifier",
};
export const FACTORY_HARNESS_LABELS: Readonly<Record<FactoryHarness, string>> = {
  claude: "Claude",
  codex: "Codex",
};
export const DEFAULT_FACTORY_BUDGET_USD = 25;

/** One role on the card: a route, or the reason it has none yet. */
export type FactoryRouteSlot =
  | { readonly status: "ready"; readonly route: FactoryRoute }
  | { readonly status: "unavailable"; readonly harness: FactoryHarness; readonly reason: string };
export type FactoryRouteSlots = { readonly [Role in FactoryRouteRole]: FactoryRouteSlot };

export interface FactoryRouteModelOption {
  readonly harness: FactoryHarness;
  readonly model: ServerProviderModel;
}

const HARNESS_DRIVERS: Readonly<Record<FactoryHarness, ProviderDriverKind>> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
};

/** Claude names its level option `effort`, Codex `reasoningEffort`. */
const LEVEL_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort"]);
/**
 * Modes that ride on a level rather than being one: prompt text, or a level
 * plus orchestration. A role never runs on them, and they never count as the
 * highest level.
 */
const SPECIAL_LEVELS: ReadonlySet<string> = new Set(["ultracode", "ultrathink", "ultra"]);

interface FamilyDefault {
  readonly family: string;
  readonly effort: string;
}

/** Newest Opus at high, Sol at high, Luna at max, as the developer asked. */
const ROLE_DEFAULTS: Readonly<
  Record<FactoryRouteRole, Partial<Record<FactoryHarness, FamilyDefault>>>
> = {
  implementer: {
    claude: { family: "opus", effort: "high" },
    codex: { family: "sol", effort: "high" },
  },
  reviewer: {
    claude: { family: "opus", effort: "high" },
    codex: { family: "sol", effort: "high" },
  },
  verifier: { codex: { family: "luna", effort: "max" } },
};

const otherHarness = (harness: FactoryHarness): FactoryHarness =>
  harness === "claude" ? "codex" : "claude";

function allowedHarnesses(
  role: FactoryRouteRole,
  implementerHarness: FactoryHarness,
): ReadonlyArray<FactoryHarness> {
  if (role === "implementer") return ["claude", "codex"];
  if (role === "reviewer") return [otherHarness(implementerHarness)];
  return ["codex"];
}

/** The harness a slot runs on, whether or not it has a route. */
export function factoryRouteSlotHarness(slot: FactoryRouteSlot): FactoryHarness {
  return slot.status === "ready" ? slot.route.harness : slot.harness;
}

/** The levels a role may run a model at: its own, without the special modes. */
export function factoryModelLevels(
  model: ServerProviderModel,
): ReadonlyArray<ProviderOptionChoice> {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (entry) => entry.type === "select" && LEVEL_OPTION_IDS.has(entry.id),
  );
  if (descriptor === undefined || descriptor.type !== "select") return [];
  const promptInjected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !promptInjected.has(option.id) && !SPECIAL_LEVELS.has(option.id),
  );
}

interface HarnessOffer {
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** Set when the harness offers nothing: the provider is missing or off. */
  readonly unavailableReason: string | null;
}

/**
 * The models a harness offers a role: the enabled default instance of its
 * driver, current models only, each with at least one level.
 */
function harnessOffer(
  providers: ReadonlyArray<ServerProvider>,
  harness: FactoryHarness,
): HarnessOffer {
  const instanceId = defaultInstanceIdForDriver(HARNESS_DRIVERS[harness]);
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  const label = FACTORY_HARNESS_LABELS[harness];
  if (provider === undefined) {
    return { models: [], unavailableReason: `${label} is not set up on this server` };
  }
  if (!provider.enabled) {
    return { models: [], unavailableReason: `${label} is turned off on this server` };
  }
  return {
    models: provider.models.filter(
      (model) => model.isLegacy !== true && factoryModelLevels(model).length > 0,
    ),
    unavailableReason: null,
  };
}

/** The numbers in a slug's digit segments: `claude-opus-5-5` → 5, 5; `gpt-5.6-sol` → 5, 6. */
function slugVersion(slug: string): ReadonlyArray<number> {
  const version: number[] = [];
  for (const segment of slug.split("-")) {
    if (!/^\d+(\.\d+)*$/.test(segment)) continue;
    for (const part of segment.split(".")) version.push(Number(part));
  }
  return version;
}

function compareVersions(left: ReadonlyArray<number>, right: ReadonlyArray<number>): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // A missing part is older than any part: 5.5 is newer than 5.
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The newest current model whose slug holds `family` as a hyphen-separated
 * segment. No model carries a family field, hence the slug rule.
 */
export function resolveLatestModelOfFamily(
  models: ReadonlyArray<ServerProviderModel>,
  family: string,
): ServerProviderModel | null {
  let latest: ServerProviderModel | null = null;
  for (const model of models) {
    if (model.isLegacy === true || !model.slug.split("-").includes(family)) continue;
    if (latest === null || compareVersions(slugVersion(model.slug), slugVersion(latest.slug)) > 0) {
      latest = model;
    }
  }
  return latest;
}

/**
 * Reasoning levels from lowest to highest. Providers send their options in
 * their own order and the server keeps it, so "highest" is ranked here, never
 * read from a position.
 */
const LEVEL_RANK: ReadonlyArray<string> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The highest level a model offers. A level this module does not know ranks
 * below every known one, so it is chosen only when nothing known is offered.
 */
function highestLevel(levels: ReadonlyArray<ProviderOptionChoice>): string | null {
  let highest: string | null = null;
  let highestRank = -2;
  for (const level of levels) {
    const rank = LEVEL_RANK.indexOf(level.id);
    // Among unknown levels the last wins, in the order the provider sent them.
    if (rank > highestRank || (rank === -1 && highestRank === -1)) {
      highest = level.id;
      highestRank = rank;
    }
  }
  return highest;
}

/** The first preferred level the model offers, otherwise its highest. */
function pickLevel(
  model: ServerProviderModel,
  preferences: ReadonlyArray<string | undefined>,
): string | null {
  const levels = factoryModelLevels(model);
  for (const preference of preferences) {
    if (preference !== undefined && levels.some((level) => level.id === preference)) {
      return preference;
    }
  }
  return highestLevel(levels);
}

function makeRoute(input: {
  readonly role: FactoryRouteRole;
  readonly harness: FactoryHarness;
  readonly model: ServerProviderModel;
  readonly effort: string;
  readonly budgetUsd: number | undefined;
}): FactoryRoute {
  const route = { harness: input.harness, model: input.model.slug, effort: input.effort };
  return input.role === "implementer" && input.harness === "claude"
    ? { ...route, budgetUsd: input.budgetUsd ?? DEFAULT_FACTORY_BUDGET_USD }
    : route;
}

function defaultRouteSlot(
  providers: ReadonlyArray<ServerProvider>,
  role: FactoryRouteRole,
  harness: FactoryHarness,
): FactoryRouteSlot {
  const preference = ROLE_DEFAULTS[role][harness];
  const label = FACTORY_HARNESS_LABELS[harness];
  if (preference === undefined) {
    return { status: "unavailable", harness, reason: `The ${role} does not run on ${label}` };
  }
  const offer = harnessOffer(providers, harness);
  if (offer.unavailableReason !== null) {
    return {
      status: "unavailable",
      harness,
      reason: `No ${label} ${preference.family} model: ${offer.unavailableReason}`,
    };
  }
  const model = resolveLatestModelOfFamily(offer.models, preference.family);
  const effort = model === null ? null : pickLevel(model, [preference.effort]);
  if (model === null || effort === null) {
    return {
      status: "unavailable",
      harness,
      reason: `No current ${label} model in the ${preference.family} family`,
    };
  }
  return {
    status: "ready",
    route: makeRoute({ role, harness, model, effort, budgetUsd: undefined }),
  };
}

/** The card's starting routes: newest Opus at high with a budget, Sol at high, Luna at max. */
export function defaultFactoryRoutes(providers: ReadonlyArray<ServerProvider>): FactoryRouteSlots {
  return {
    implementer: defaultRouteSlot(providers, "implementer", "claude"),
    reviewer: defaultRouteSlot(providers, "reviewer", "codex"),
    verifier: defaultRouteSlot(providers, "verifier", "codex"),
  };
}

/** The models a role may pick from, grouped by harness in provider order. */
export function factoryRouteModelOptions(
  providers: ReadonlyArray<ServerProvider>,
  role: FactoryRouteRole,
  implementerHarness: FactoryHarness,
): ReadonlyArray<FactoryRouteModelOption> {
  const options: FactoryRouteModelOption[] = [];
  for (const harness of allowedHarnesses(role, implementerHarness)) {
    for (const model of harnessOffer(providers, harness).models) {
      options.push({ harness, model });
    }
  }
  return options;
}

function findOfferedModel(
  providers: ReadonlyArray<ServerProvider>,
  selection: { readonly harness: FactoryHarness; readonly model: string },
): ServerProviderModel | undefined {
  return harnessOffer(providers, selection.harness).models.find(
    (model) => model.slug === selection.model,
  );
}

/** The levels a role may pick for a model; empty when the model is not offered. */
export function factoryRouteEffortOptions(
  providers: ReadonlyArray<ServerProvider>,
  selection: { readonly harness: FactoryHarness; readonly model: string },
): ReadonlyArray<ProviderOptionChoice> {
  const model = findOfferedModel(providers, selection);
  return model === undefined ? [] : factoryModelLevels(model);
}

/**
 * Picks a model for a role. The level carries over when the new model offers
 * it. When the implementer changes family, the reviewer moves to its default
 * in the other family; within a family, a chosen reviewer stays.
 */
export function changeFactoryRouteModel(
  slots: FactoryRouteSlots,
  providers: ReadonlyArray<ServerProvider>,
  role: FactoryRouteRole,
  selection: { readonly harness: FactoryHarness; readonly model: string },
): FactoryRouteSlots {
  const implementerHarness = factoryRouteSlotHarness(slots.implementer);
  if (!allowedHarnesses(role, implementerHarness).includes(selection.harness)) return slots;
  const model = findOfferedModel(providers, selection);
  if (model === undefined) return slots;
  const previous = slots[role].status === "ready" ? slots[role].route : null;
  const effort = pickLevel(model, [
    previous?.effort,
    ROLE_DEFAULTS[role][selection.harness]?.effort,
  ]);
  if (effort === null) return slots;
  const route = makeRoute({
    role,
    harness: selection.harness,
    model,
    effort,
    budgetUsd: previous?.harness === "claude" ? previous.budgetUsd : undefined,
  });
  const next: FactoryRouteSlots = { ...slots, [role]: { status: "ready", route } };
  if (role !== "implementer") return next;
  const reviewer = next.reviewer;
  return reviewer.status === "ready" && reviewer.route.harness !== selection.harness
    ? next
    : {
        ...next,
        reviewer: defaultRouteSlot(providers, "reviewer", otherHarness(selection.harness)),
      };
}

/**
 * Holds edited rows to the provider lists as they are now: the card keeps its
 * edits across a provider update, and this runs on every render before Approve
 * reads them. A route whose model is no longer offered to its role becomes
 * unavailable with the reason, so Approve waits for a new choice rather than
 * sending a route the server dropped. A level the model no longer offers falls
 * back as a default does. Returns `slots` itself when nothing changed.
 */
export function reconcileFactoryRouteSlots(
  slots: FactoryRouteSlots,
  providers: ReadonlyArray<ServerProvider>,
): FactoryRouteSlots {
  const implementerHarness = factoryRouteSlotHarness(slots.implementer);
  let changed = false;
  const reconcile = (role: FactoryRouteRole): FactoryRouteSlot => {
    const slot = slots[role];
    if (slot.status !== "ready") return slot;
    const { route } = slot;
    const offer = harnessOffer(providers, route.harness);
    const model = offer.models.find((entry) => entry.slug === route.model);
    const allowed = allowedHarnesses(role, implementerHarness).includes(route.harness);
    if (!allowed || model === undefined) {
      changed = true;
      return {
        status: "unavailable",
        harness: route.harness,
        reason:
          offer.unavailableReason ??
          `${route.model} is no longer offered by ${FACTORY_HARNESS_LABELS[route.harness]}`,
      };
    }
    const effort = pickLevel(model, [route.effort, ROLE_DEFAULTS[role][route.harness]?.effort]);
    if (effort === route.effort || effort === null) return slot;
    changed = true;
    return { status: "ready", route: { ...route, effort } };
  };
  const next: FactoryRouteSlots = {
    implementer: reconcile("implementer"),
    reviewer: reconcile("reviewer"),
    verifier: reconcile("verifier"),
  };
  return changed ? next : slots;
}

export function changeFactoryRouteEffort(
  slots: FactoryRouteSlots,
  role: FactoryRouteRole,
  effort: string,
): FactoryRouteSlots {
  const slot = slots[role];
  if (slot.status !== "ready") return slots;
  return { ...slots, [role]: { status: "ready", route: { ...slot.route, effort } } };
}

/** Sets a Claude implementer's budget; `NaN` keeps Approve disabled until it is fixed. */
export function changeFactoryRouteBudget(
  slots: FactoryRouteSlots,
  budgetUsd: number,
): FactoryRouteSlots {
  const slot = slots.implementer;
  if (slot.status !== "ready" || slot.route.harness !== "claude") return slots;
  return { ...slots, implementer: { status: "ready", route: { ...slot.route, budgetUsd } } };
}

/** A typed budget: a number, or `NaN` when the field holds none. */
export function parseFactoryBudgetUsd(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

/** sf-team's two rules, plus the budget a Claude implementer launches with. Empty when valid. */
export function validateFactoryRoutes(routes: FactoryRoutes): ReadonlyArray<string> {
  const violations: string[] = [];
  if (routes.verifier.harness !== "codex") violations.push("The verifier runs on Codex.");
  if (routes.reviewer.harness === routes.implementer.harness) {
    violations.push("The reviewer runs on the other family from the implementer.");
  }
  const budget = routes.implementer.budgetUsd;
  if (
    routes.implementer.harness === "claude" &&
    (budget === undefined || !Number.isFinite(budget) || budget <= 0)
  ) {
    violations.push("A Claude implementer needs a dollar budget above zero.");
  }
  return violations;
}

/** The routes Approve sends, or null while a role has none or a rule is broken. */
export function readyFactoryRoutes(slots: FactoryRouteSlots): FactoryRoutes | null {
  const { implementer, reviewer, verifier } = slots;
  if (
    implementer.status !== "ready" ||
    reviewer.status !== "ready" ||
    verifier.status !== "ready"
  ) {
    return null;
  }
  const routes = {
    implementer: implementer.route,
    reviewer: reviewer.route,
    verifier: verifier.route,
  };
  return validateFactoryRoutes(routes).length === 0 ? routes : null;
}

/** What a read-only row shows: the model's name and the level's label, or their ids. */
export function describeFactoryRoute(
  providers: ReadonlyArray<ServerProvider>,
  route: FactoryRoute,
): { readonly model: string; readonly effort: string } {
  const instanceId = defaultInstanceIdForDriver(HARNESS_DRIVERS[route.harness]);
  const model = providers
    .find((entry) => entry.instanceId === instanceId)
    ?.models.find((entry) => entry.slug === route.model);
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (entry) => entry.type === "select" && LEVEL_OPTION_IDS.has(entry.id),
  );
  const level =
    descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === route.effort)
      : undefined;
  return { model: model?.name ?? route.model, effort: level?.label ?? route.effort };
}
