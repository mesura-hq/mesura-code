/**
 * Phase 4 fence, acceptance criteria 2 (defaults), 4 (the routing rules) and
 * 5 (fallbacks), for the shared module web and Android both build from.
 *
 * Entry point: `./routes.ts`, fed with provider model lists shaped as the
 * server sends them (`ServerProvider[]`, see `makeFactoryRouteProviders`).
 * The rules are sf-team's *Frame*: the verifier runs on Codex, and the
 * reviewer runs on the other family from the implementer. The file shape is
 * sf-team's `--routes` file (`~/.agent-env/skills/core/sf-team/ROUTES.md`).
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changeFactoryRouteEffort,
  changeFactoryRouteModel,
  defaultFactoryRoutes,
  factoryRouteEffortOptions,
  factoryRouteModelOptions,
  readyFactoryRoutes,
  reconcileFactoryRouteSlots,
  resolveLatestModelOfFamily,
  validateFactoryRoutes,
  type FactoryRoutes,
} from "./routes.ts";
import {
  FACTORY_CLAUDE_TEST_MODELS,
  FACTORY_CODEX_TEST_MODELS,
  FACTORY_DEFAULT_TEST_ROUTES,
  makeFactoryRouteProviders,
  type FactoryTestModel,
} from "./testing.ts";

const modelsOf = (driver: "claudeAgent" | "codex", models: ReadonlyArray<FactoryTestModel>) => {
  const provider = makeFactoryRouteProviders(
    driver === "claudeAgent" ? { claude: models, codex: null } : { claude: null, codex: models },
  )[0];
  return provider?.models ?? [];
};

const DEFAULT_ROUTES: FactoryRoutes = FACTORY_DEFAULT_TEST_ROUTES;

describe("newest model of a family (phase 4 fence, criterion 2)", () => {
  it("phase4 AC2 picks the newest non-legacy opus whatever the list order", () => {
    const models = modelsOf("claudeAgent", FACTORY_CLAUDE_TEST_MODELS);
    expect(resolveLatestModelOfFamily(models, "opus")?.slug).toBe("claude-opus-5-5");
    // Reversed by index: Hermes has no `toReversed`, and `reverse` mutates.
    const reversed = Array.from(models, (_, index) => models[models.length - 1 - index]!);
    expect(resolveLatestModelOfFamily(reversed, "opus")?.slug).toBe("claude-opus-5-5");
  });

  it("phase4 AC2 reads version segments as numbers, dotted or hyphenated", () => {
    const models = modelsOf("codex", [
      { slug: "gpt-9-sol", name: "GPT-9 Sol" },
      { slug: "gpt-10-sol", name: "GPT-10 Sol" },
      { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
    expect(resolveLatestModelOfFamily(models, "sol")?.slug).toBe("gpt-10-sol");
    const claude = modelsOf("claudeAgent", [
      { slug: "claude-opus-5-10", name: "Claude Opus 5.10" },
      { slug: "claude-opus-5-9", name: "Claude Opus 5.9" },
      { slug: "claude-opus-5", name: "Claude Opus 5" },
    ]);
    expect(resolveLatestModelOfFamily(claude, "opus")?.slug).toBe("claude-opus-5-10");
    expect(
      resolveLatestModelOfFamily(modelsOf("codex", FACTORY_CODEX_TEST_MODELS), "sol")?.slug,
    ).toBe("gpt-6-sol");
  });

  it("phase4 AC2 matches the family as a whole slug segment, never a substring", () => {
    const models = modelsOf("codex", [
      { slug: "gpt-7-solace", name: "GPT-7 Solace" },
      { slug: "gpt-8-console", name: "GPT-8 Console" },
      { slug: "gpt-6-sol", name: "GPT-6 Sol" },
    ]);
    expect(resolveLatestModelOfFamily(models, "sol")?.slug).toBe("gpt-6-sol");
    expect(
      resolveLatestModelOfFamily(
        modelsOf("codex", [{ slug: "gpt-7-solace", name: "GPT-7 Solace" }]),
        "sol",
      ),
    ).toBeNull();
  });

  it("phase4 AC2 skips legacy models and answers null when the family is absent", () => {
    expect(
      resolveLatestModelOfFamily(
        modelsOf("claudeAgent", [{ slug: "claude-opus-6", name: "Opus 6", isLegacy: true }]),
        "opus",
      ),
    ).toBeNull();
    expect(resolveLatestModelOfFamily([], "luna")).toBeNull();
  });

  it("phase4 AC2 defaults to the newest Opus at high with 25 dollars, Sol at high and Luna at max", () => {
    const slots = defaultFactoryRoutes(makeFactoryRouteProviders());
    expect(slots).toEqual({
      implementer: { status: "ready", route: DEFAULT_ROUTES.implementer },
      reviewer: { status: "ready", route: DEFAULT_ROUTES.reviewer },
      verifier: { status: "ready", route: DEFAULT_ROUTES.verifier },
    });
    expect(readyFactoryRoutes(slots)).toEqual(DEFAULT_ROUTES);
  });
});

describe("routing rules (phase 4 fence, criterion 4)", () => {
  const providers = makeFactoryRouteProviders();

  it("phase4 AC4 offers the verifier Codex models only", () => {
    const options = factoryRouteModelOptions(providers, "verifier", "claude");
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.harness === "codex")).toBe(true);
    expect(options.map((option) => option.model.slug)).toEqual(
      expect.arrayContaining(["gpt-6-luna", "gpt-6-sol"]),
    );
    expect(factoryRouteModelOptions(providers, "verifier", "codex").map((o) => o.harness)).toEqual(
      options.map(() => "codex"),
    );
  });

  it("phase4 AC4 offers the reviewer only the other family from the implementer", () => {
    const forClaude = factoryRouteModelOptions(providers, "reviewer", "claude");
    expect(forClaude.length).toBeGreaterThan(0);
    expect(forClaude.every((option) => option.harness === "codex")).toBe(true);
    const forCodex = factoryRouteModelOptions(providers, "reviewer", "codex");
    expect(forCodex.length).toBeGreaterThan(0);
    expect(forCodex.every((option) => option.harness === "claude")).toBe(true);
    const implementer = factoryRouteModelOptions(providers, "implementer", "claude");
    expect(new Set(implementer.map((option) => option.harness))).toEqual(
      new Set(["claude", "codex"]),
    );
  });

  it("phase4 AC4 moves the reviewer to its default in the other family when the implementer changes family", () => {
    const toCodex = changeFactoryRouteModel(
      defaultFactoryRoutes(providers),
      providers,
      "implementer",
      { harness: "codex", model: "gpt-6-sol" },
    );
    expect(toCodex.implementer).toMatchObject({
      status: "ready",
      route: { harness: "codex", model: "gpt-6-sol" },
    });
    expect(toCodex.implementer.status === "ready" && "budgetUsd" in toCodex.implementer.route).toBe(
      false,
    );
    expect(toCodex.reviewer).toEqual({
      status: "ready",
      route: { harness: "claude", model: "claude-opus-5-5", effort: "high" },
    });
    expect(toCodex.verifier).toEqual({ status: "ready", route: DEFAULT_ROUTES.verifier });
    expect(validateFactoryRoutes(readyFactoryRoutes(toCodex)!)).toEqual([]);

    const backToClaude = changeFactoryRouteModel(toCodex, providers, "implementer", {
      harness: "claude",
      model: "claude-sonnet-5",
    });
    expect(backToClaude.implementer).toMatchObject({
      status: "ready",
      route: { harness: "claude", model: "claude-sonnet-5", budgetUsd: 25 },
    });
    expect(backToClaude.reviewer).toEqual({ status: "ready", route: DEFAULT_ROUTES.reviewer });
  });

  it("phase4 AC4 keeps a chosen reviewer when the implementer changes model within its family", () => {
    const withAstra = changeFactoryRouteModel(
      defaultFactoryRoutes(providers),
      providers,
      "reviewer",
      {
        harness: "codex",
        model: "gpt-6-astra",
      },
    );
    const changed = changeFactoryRouteModel(withAstra, providers, "implementer", {
      harness: "claude",
      model: "claude-fable-5-1",
    });
    expect(changed.reviewer).toMatchObject({
      status: "ready",
      route: { harness: "codex", model: "gpt-6-astra" },
    });
  });

  it("phase4 AC4 refuses a Claude verifier and a reviewer of the implementer's family", () => {
    expect(validateFactoryRoutes(DEFAULT_ROUTES)).toEqual([]);
    expect(
      validateFactoryRoutes({
        ...DEFAULT_ROUTES,
        verifier: { harness: "claude", model: "claude-opus-5-5", effort: "high" },
      }),
    ).toHaveLength(1);
    expect(
      validateFactoryRoutes({
        ...DEFAULT_ROUTES,
        reviewer: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
      }),
    ).toHaveLength(1);
    expect(
      validateFactoryRoutes({
        implementer: { harness: "codex", model: "gpt-6-sol", effort: "high" },
        reviewer: { harness: "codex", model: "gpt-6-astra", effort: "high" },
        verifier: { harness: "codex", model: "gpt-6-luna", effort: "max" },
      }),
    ).toHaveLength(1);
  });

  it("phase4 AC3 refuses a Claude implementer without a positive dollar budget", () => {
    const { budgetUsd: _budget, ...withoutBudget } = DEFAULT_ROUTES.implementer;
    expect(validateFactoryRoutes({ ...DEFAULT_ROUTES, implementer: withoutBudget })).toHaveLength(
      1,
    );
    expect(
      validateFactoryRoutes({
        ...DEFAULT_ROUTES,
        implementer: { ...DEFAULT_ROUTES.implementer, budgetUsd: 0 },
      }),
    ).toHaveLength(1);
    expect(
      validateFactoryRoutes({
        ...DEFAULT_ROUTES,
        implementer: { ...DEFAULT_ROUTES.implementer, budgetUsd: 40 },
      }),
    ).toEqual([]);
  });
});

describe("fallbacks (phase 4 fence, criterion 5)", () => {
  it("phase4 AC5 falls back to the model's highest offered level when the default is not offered", () => {
    const providers = makeFactoryRouteProviders({
      claude: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", levels: ["low", "medium"] }],
      codex: [
        { slug: "gpt-6-sol", name: "GPT-6 Sol", levels: ["low", "medium"] },
        { slug: "gpt-6-luna", name: "GPT-6 Luna", levels: ["low", "medium", "high"] },
      ],
    });
    const slots = defaultFactoryRoutes(providers);
    expect(slots.implementer).toMatchObject({ status: "ready", route: { effort: "medium" } });
    expect(slots.reviewer).toMatchObject({ status: "ready", route: { effort: "medium" } });
    expect(slots.verifier).toMatchObject({ status: "ready", route: { effort: "high" } });
  });

  it("phase4 AC5 never falls back to a level the provider sends as prompt text", () => {
    const providers = makeFactoryRouteProviders({
      claude: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          levels: ["low", "medium", "ultrathink"],
          promptInjectedLevels: ["ultrathink"],
        },
      ],
    });
    expect(defaultFactoryRoutes(providers).implementer).toMatchObject({
      status: "ready",
      route: { effort: "medium" },
    });
    expect(
      factoryRouteEffortOptions(providers, { harness: "claude", model: "claude-opus-5-5" }).map(
        (option) => option.id,
      ),
    ).toEqual(["low", "medium"]);
  });

  it("phase4 AC5 marks a role unavailable with its reason when no model of its family is offered", () => {
    const withoutLuna = defaultFactoryRoutes(
      makeFactoryRouteProviders({ codex: [{ slug: "gpt-6-sol", name: "GPT-6 Sol" }] }),
    );
    expect(withoutLuna.verifier.status).toBe("unavailable");
    expect(withoutLuna.verifier.status === "unavailable" && withoutLuna.verifier.reason).toMatch(
      /luna/i,
    );
    expect(withoutLuna.reviewer).toEqual({ status: "ready", route: DEFAULT_ROUTES.reviewer });
    expect(readyFactoryRoutes(withoutLuna)).toBeNull();

    const withoutClaude = defaultFactoryRoutes(makeFactoryRouteProviders({ claude: null }));
    expect(withoutClaude.implementer.status).toBe("unavailable");
    expect(
      withoutClaude.implementer.status === "unavailable" && withoutClaude.implementer.reason,
    ).toMatch(/opus/i);
    expect(readyFactoryRoutes(withoutClaude)).toBeNull();
  });

  it("phase4 AC5 gives an unavailable role its route once a model of an allowed family is chosen", () => {
    const providers = makeFactoryRouteProviders({
      codex: [
        { slug: "gpt-6-sol", name: "GPT-6 Sol" },
        { slug: "gpt-6-astra", name: "GPT-6 Astra" },
      ],
    });
    const chosen = changeFactoryRouteModel(defaultFactoryRoutes(providers), providers, "verifier", {
      harness: "codex",
      model: "gpt-6-astra",
    });
    expect(chosen.verifier).toMatchObject({
      status: "ready",
      route: { harness: "codex", model: "gpt-6-astra" },
    });
    expect(readyFactoryRoutes(chosen)?.verifier.model).toBe("gpt-6-astra");
  });
});

describe("what a role may run on (phase 4 coordinator decisions 1–3)", () => {
  it("phase4 decision 1 never offers or falls back to a special mode as a level", () => {
    const providers = makeFactoryRouteProviders({
      claude: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          levels: ["low", "medium", "ultracode", "ultrathink"],
          promptInjectedLevels: [],
        },
      ],
      codex: [
        { slug: "gpt-6-sol", name: "GPT-6 Sol", levels: ["low", "medium", "ultra"] },
        { slug: "gpt-6-luna", name: "GPT-6 Luna", levels: ["low", "high", "ultra"] },
      ],
    });
    const slots = defaultFactoryRoutes(providers);
    expect(slots.implementer).toMatchObject({ status: "ready", route: { effort: "medium" } });
    expect(slots.reviewer).toMatchObject({ status: "ready", route: { effort: "medium" } });
    expect(slots.verifier).toMatchObject({ status: "ready", route: { effort: "high" } });
    expect(
      factoryRouteEffortOptions(providers, { harness: "claude", model: "claude-opus-5-5" }).map(
        (option) => option.id,
      ),
    ).toEqual(["low", "medium"]);
    expect(
      factoryRouteEffortOptions(providers, { harness: "codex", model: "gpt-6-luna" }).map(
        (option) => option.id,
      ),
    ).toEqual(["low", "high"]);
  });

  it("phase4 decision 2 makes a turned-off provider's roles unavailable with a reason naming it", () => {
    const providers = makeFactoryRouteProviders({ codexProvider: { enabled: false } });
    const slots = defaultFactoryRoutes(providers);
    expect(slots.implementer.status).toBe("ready");
    for (const role of ["reviewer", "verifier"] as const) {
      const slot = slots[role];
      expect(slot.status, role).toBe("unavailable");
      expect(slot.status === "unavailable" && slot.reason, role).toMatch(/Codex/);
    }
    expect(factoryRouteModelOptions(providers, "verifier", "claude")).toEqual([]);
    expect(readyFactoryRoutes(slots)).toBeNull();
  });

  it("phase4 decision 2 reads only the default instance of each driver", () => {
    const providers = makeFactoryRouteProviders({
      codexProvider: { instanceId: ProviderInstanceId.make("codex_work") },
    });
    const slots = defaultFactoryRoutes(providers);
    expect(slots.verifier.status).toBe("unavailable");
    expect(slots.verifier.status === "unavailable" && slots.verifier.reason).toMatch(/Codex/);
    expect(factoryRouteModelOptions(providers, "reviewer", "claude")).toEqual([]);
  });

  it("phase4 decision 2 offers current models only, never legacy ones", () => {
    const slugs = factoryRouteModelOptions(
      makeFactoryRouteProviders(),
      "implementer",
      "claude",
    ).map((option) => option.model.slug);
    expect(slugs).toContain("claude-opus-5-5");
    expect(slugs).not.toContain("claude-opus-6");
  });

  it("phase4 decision 3 does not offer a model that has no level option", () => {
    const providers = makeFactoryRouteProviders({
      claude: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", levels: [] },
        { slug: "claude-opus-5", name: "Claude Opus 5" },
      ],
    });
    expect(defaultFactoryRoutes(providers).implementer).toMatchObject({
      status: "ready",
      route: { model: "claude-opus-5" },
    });
    expect(
      factoryRouteModelOptions(providers, "implementer", "claude").map(
        (option) => option.model.slug,
      ),
    ).not.toContain("claude-opus-5-5");
    const unchanged = defaultFactoryRoutes(providers);
    expect(
      changeFactoryRouteModel(unchanged, providers, "implementer", {
        harness: "claude",
        model: "claude-opus-5-5",
      }),
    ).toBe(unchanged);
  });
});

describe("level ranking and provider changes (phase 4 review P1-1, P1-2)", () => {
  it("phase4 P1-2 falls back to the highest level whatever order the provider sends", () => {
    const providers = makeFactoryRouteProviders({
      claude: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", levels: ["medium", "low"] }],
      codex: [
        { slug: "gpt-6-sol", name: "GPT-6 Sol", levels: ["xhigh", "low", "medium"] },
        { slug: "gpt-6-luna", name: "GPT-6 Luna", levels: ["high", "low", "minimal"] },
      ],
    });
    const slots = defaultFactoryRoutes(providers);
    expect(slots.implementer).toMatchObject({ status: "ready", route: { effort: "medium" } });
    expect(slots.reviewer).toMatchObject({ status: "ready", route: { effort: "xhigh" } });
    expect(slots.verifier).toMatchObject({ status: "ready", route: { effort: "high" } });
  });

  it("phase4 P1-2 ranks a level it does not know below every known one", () => {
    const providers = makeFactoryRouteProviders({
      codex: [
        { slug: "gpt-6-sol", name: "GPT-6 Sol", levels: ["medium", "turbo"] },
        { slug: "gpt-6-luna", name: "GPT-6 Luna", levels: ["turbo", "hyper"] },
      ],
    });
    const slots = defaultFactoryRoutes(providers);
    expect(slots.reviewer).toMatchObject({ status: "ready", route: { effort: "medium" } });
    expect(slots.verifier).toMatchObject({ status: "ready", route: { effort: "hyper" } });
  });

  const providers = makeFactoryRouteProviders();
  const edited = changeFactoryRouteModel(defaultFactoryRoutes(providers), providers, "reviewer", {
    harness: "codex",
    model: "gpt-6-astra",
  });

  it("phase4 P1-1 keeps edited routes the provider lists still offer, as the same object", () => {
    expect(reconcileFactoryRouteSlots(edited, providers)).toBe(edited);
  });

  it("phase4 P1-1 makes an edited route unavailable once its provider is turned off", () => {
    const off = makeFactoryRouteProviders({ codexProvider: { enabled: false } });
    const reconciled = reconcileFactoryRouteSlots(edited, off);
    expect(reconciled.implementer).toEqual(edited.implementer);
    for (const role of ["reviewer", "verifier"] as const) {
      expect(reconciled[role].status, role).toBe("unavailable");
      expect(reconciled[role].status === "unavailable" && reconciled[role].reason).toMatch(
        /Codex is turned off/,
      );
    }
    expect(readyFactoryRoutes(reconciled)).toBeNull();
  });

  it("phase4 P1-1 makes an edited route unavailable once its model is gone", () => {
    const withoutAstra = makeFactoryRouteProviders({
      codex: FACTORY_CODEX_TEST_MODELS.filter((model) => model.slug !== "gpt-6-astra"),
    });
    const reconciled = reconcileFactoryRouteSlots(edited, withoutAstra);
    expect(reconciled.reviewer).toEqual({
      status: "unavailable",
      harness: "codex",
      reason: "gpt-6-astra is no longer offered by Codex",
    });
    expect(reconciled.verifier).toEqual(edited.verifier);
    expect(readyFactoryRoutes(reconciled)).toBeNull();
    // Choosing again gives the role its route back.
    const chosen = changeFactoryRouteModel(reconciled, withoutAstra, "reviewer", {
      harness: "codex",
      model: "gpt-6-sol",
    });
    expect(readyFactoryRoutes(reconcileFactoryRouteSlots(chosen, withoutAstra))).not.toBeNull();
  });

  it("phase4 P1-1 lowers an edited level the model no longer offers to its highest", () => {
    const withMax = changeFactoryRouteEffort(edited, "verifier", "max");
    const lowered = makeFactoryRouteProviders({
      codex: FACTORY_CODEX_TEST_MODELS.map((model) =>
        model.slug === "gpt-6-luna" ? { ...model, levels: ["low", "xhigh", "medium"] } : model,
      ),
    });
    const reconciled = reconcileFactoryRouteSlots(withMax, lowered);
    expect(reconciled.verifier).toEqual({
      status: "ready",
      route: { harness: "codex", model: "gpt-6-luna", effort: "xhigh" },
    });
  });
});
