import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  buildCombinedPickerCandidate,
  createCombinedPickerState,
  resolveCombinedPickerRow,
  setCombinedPickerOption,
  setCombinedPickerRuntimeMode,
  stepCombinedPickerEffort,
  type CombinedPickerRowInput,
  type CombinedPickerSavedSelection,
} from "./combinedPickerState";
import { modelPickerModelKey } from "./modelPickerKeys";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

function select(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  extra: Partial<SelectDescriptor> = {},
): SelectDescriptor {
  return { id, label: id, type: "select", options: [...options], ...extra };
}

function model(
  slug: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: { optionDescriptors: [...descriptors] },
  };
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");
const CODEX = ProviderInstanceId.make("codex");
const CODEX_PERSONAL = ProviderInstanceId.make("codex_personal");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CURSOR = ProviderInstanceId.make("cursor");
const OPENCODE = ProviderInstanceId.make("opencode");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");

const CODEX_REASONING = select("reasoningEffort", [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
]);
const SERVICE_TIER = select("serviceTier", [
  { id: "default", label: "Standard", isDefault: true },
  { id: "priority", label: "Fast" },
]);
const CODEX_MODELS = [
  model("gpt-5.4", [CODEX_REASONING, SERVICE_TIER]),
  model("gpt-5.5", [CODEX_REASONING]),
];
// A second instance of the same driver advertises a different effort list.
const CODEX_PERSONAL_MODELS = [
  model("gpt-5.4", [
    select("reasoningEffort", [
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low", isDefault: true },
      { id: "high", label: "High" },
    ]),
  ]),
];
const CLAUDE_MODELS = [
  model("claude-opus-5", [
    select(
      "effort",
      [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      { promptInjectedValues: ["ultrathink"] },
    ),
  ]),
];
const OPENCODE_MODELS = [
  model("openrouter/deep", [
    select("agent", [
      { id: "build", label: "Build", isDefault: true },
      { id: "plan", label: "Plan" },
    ]),
    select("variant", [
      { id: "max", label: "Max", isDefault: true },
      { id: "custom-deep", label: "Custom deep" },
      { id: "low", label: "Low" },
    ]),
  ]),
];
const CURSOR_MODELS = [
  model("composer-2.5", [
    { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: true },
  ]),
];

const CONTEXT = { planModeEnabled: true, allowPromptInjectedEffort: true } as const;

function saved(
  overrides: Partial<CombinedPickerSavedSelection> & {
    /** Remembered options of rows other than the saved one, keyed `instance/model`. */
    remembered?: Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>;
  } = {},
): CombinedPickerSavedSelection {
  const { remembered = {}, ...rest } = overrides;
  return {
    instanceId: CODEX,
    model: "gpt-5.4",
    options: undefined,
    rememberedOptions: (instanceId, slug) => remembered[`${instanceId}/${slug}`],
    prompt: "Draft",
    runtimeMode: "approval-required",
    ...rest,
  };
}

function candidateFor(
  state: ReturnType<typeof createCombinedPickerState>,
  input: CombinedPickerRowInput,
  context: Parameters<typeof buildCombinedPickerCandidate>[2] = CONTEXT,
  prompt = "Draft",
) {
  return buildCombinedPickerCandidate(state, input, context, prompt, "row");
}

function row(
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  slug: string,
  models: ReadonlyArray<ServerProviderModel>,
): CombinedPickerRowInput {
  return { instanceId, driverKind, model: slug, models };
}

const CODEX_54 = row(CODEX, CODEX_DRIVER, "gpt-5.4", CODEX_MODELS);
const CODEX_55 = row(CODEX, CODEX_DRIVER, "gpt-5.5", CODEX_MODELS);
const PERSONAL_54 = row(CODEX_PERSONAL, CODEX_DRIVER, "gpt-5.4", CODEX_PERSONAL_MODELS);
const CLAUDE_OPUS = row(CLAUDE, CLAUDE_DRIVER, "claude-opus-5", CLAUDE_MODELS);
const OPENCODE_DEEP = row(OPENCODE, OPENCODE_DRIVER, "openrouter/deep", OPENCODE_MODELS);

function effortOf(
  state: ReturnType<typeof createCombinedPickerState>,
  input: CombinedPickerRowInput,
  context: { planModeEnabled: boolean; allowPromptInjectedEffort: boolean } = CONTEXT,
) {
  return resolveCombinedPickerRow(state, input, context).effort?.value ?? null;
}

function step(
  state: ReturnType<typeof createCombinedPickerState>,
  input: CombinedPickerRowInput,
  direction: 1 | -1,
  times = 1,
) {
  let next = state;
  for (let index = 0; index < times; index += 1) {
    next = stepCombinedPickerEffort(next, input, CONTEXT, direction);
  }
  return next;
}

describe("combinedPickerState seeding", () => {
  it("combined picker state seeds the saved row from its options and other rows from their memory", () => {
    const state = createCombinedPickerState(
      saved({
        options: selections(["reasoningEffort", "high"]),
        remembered: { [`${CODEX_PERSONAL}/gpt-5.4`]: selections(["reasoningEffort", "minimal"]) },
      }),
    );

    expect(resolveCombinedPickerRow(state, CODEX_54, CONTEXT).key).toBe(
      modelPickerModelKey(CODEX, "gpt-5.4"),
    );
    expect(resolveCombinedPickerRow(state, PERSONAL_54, CONTEXT).key).toBe(
      modelPickerModelKey(CODEX_PERSONAL, "gpt-5.4"),
    );
    expect(effortOf(state, CODEX_54)).toBe("high");
    expect(effortOf(state, PERSONAL_54)).toBe("minimal");
    expect(resolveCombinedPickerRow(state, CODEX_54, CONTEXT).effort?.label).toBe("High");
  });

  it("guard: another model of the saved instance starts at its defaults, not the saved options", () => {
    // A model-only switch restores that model's memory or its defaults, so the
    // row must not preview the saved model's effort.
    const state = createCombinedPickerState(
      saved({ options: selections(["reasoningEffort", "high"]) }),
    );

    expect(effortOf(state, CODEX_55)).toBe("medium");
  });

  it("combined picker state shows a provider-reported effort for the saved row's default", () => {
    const state = createCombinedPickerState(
      saved({
        reportedModelSelection: {
          instanceId: CODEX,
          model: "gpt-5.4",
          options: selections(["reasoningEffort", "high"]),
        },
      }),
    );

    expect(resolveCombinedPickerRow(state, CODEX_54, CONTEXT).effort?.label).toBe("High");
    // Stepping starts from the value shown.
    expect(effortOf(step(state, CODEX_54, 1), CODEX_54)).toBe("xhigh");
    // Another model is not described by the saved model's report.
    expect(effortOf(state, CODEX_55)).toBe("medium");
  });

  it("combined picker state seeds Cursor fast mode as Normal without an explicit choice", () => {
    const state = createCombinedPickerState(saved({ instanceId: CURSOR, model: "composer-2.5" }));
    const resolved = resolveCombinedPickerRow(
      state,
      row(CURSOR, CURSOR_DRIVER, "composer-2.5", CURSOR_MODELS),
      CONTEXT,
    );

    expect(resolved.effort).toBeNull();
    expect(
      resolved.optionState.extraDescriptors.find((descriptor) => descriptor.id === "fastMode"),
    ).toMatchObject({ type: "boolean", currentValue: false });
  });

  it("combined picker state seeds access from the effective saved value", () => {
    const state = createCombinedPickerState(saved({ runtimeMode: "auto-accept-edits" }));

    expect(state.runtimeMode).toBe("auto-accept-edits");
    // An untouched access control writes nothing: choosing a model alone must
    // not persist an access override (plan phase 2, independent dirty state).
    expect(candidateFor(state, CODEX_54).runtimeMode).toBeUndefined();
  });
});

describe("combinedPickerState effort stepping", () => {
  it("combined picker state steps effort in the exact instance's order and clamps at both ends", () => {
    let state = createCombinedPickerState(saved());

    state = step(state, PERSONAL_54, 1);
    expect(effortOf(state, PERSONAL_54)).toBe("high");
    expect(resolveCombinedPickerRow(state, PERSONAL_54, CONTEXT).effort?.canIncrease).toBe(false);
    state = step(state, PERSONAL_54, 1, 3);
    expect(effortOf(state, PERSONAL_54)).toBe("high");

    state = step(state, PERSONAL_54, -1, 5);
    expect(effortOf(state, PERSONAL_54)).toBe("minimal");
    expect(resolveCombinedPickerRow(state, PERSONAL_54, CONTEXT).effort?.canDecrease).toBe(false);
    expect(effortOf(state, CODEX_54)).toBe("medium");
  });

  it("combined picker state keeps OpenCode variant order and arbitrary variant ids", () => {
    let state = createCombinedPickerState(
      saved({ instanceId: OPENCODE, model: "openrouter/deep" }),
    );
    const resolved = resolveCombinedPickerRow(state, OPENCODE_DEEP, CONTEXT);

    expect(resolved.effort?.descriptorId).toBe("variant");
    expect(resolved.effort?.options.map((option) => option.id)).toEqual([
      "max",
      "custom-deep",
      "low",
    ]);
    state = step(state, OPENCODE_DEEP, 1);
    expect(effortOf(state, OPENCODE_DEEP)).toBe("custom-deep");
    expect(candidateFor(state, OPENCODE_DEEP).modelSelection.options).toEqual(
      expect.arrayContaining([{ id: "variant", value: "custom-deep" }]),
    );
  });

  it("combined picker state retains pending edits per row within one opening", () => {
    let state = createCombinedPickerState(saved());

    state = step(state, CODEX_54, 1);
    state = step(state, CODEX_55, -1);
    state = step(state, PERSONAL_54, 1);

    expect(effortOf(state, CODEX_54)).toBe("high");
    expect(effortOf(state, CODEX_55)).toBe("low");
    expect(effortOf(state, PERSONAL_54)).toBe("high");
  });

  it("combined picker state reopens from saved values after a dismissal", () => {
    const savedSelection = saved({
      options: selections(["reasoningEffort", "low"]),
    });
    const edited = step(createCombinedPickerState(savedSelection), CODEX_54, 1, 2);
    expect(effortOf(edited, CODEX_54)).toBe("high");

    expect(effortOf(createCombinedPickerState(savedSelection), CODEX_54)).toBe("low");
  });

  it("combined picker state gives a model without an effort descriptor no inline editor", () => {
    const state = createCombinedPickerState(saved());
    const antigravity = row(ANTIGRAVITY, ANTIGRAVITY_DRIVER, "gemini-pro", [
      model("gemini-pro", []),
    ]);

    expect(resolveCombinedPickerRow(state, antigravity, CONTEXT).effort).toBeNull();
    expect(stepCombinedPickerEffort(state, antigravity, CONTEXT, 1)).toBe(state);
  });

  it("combined picker state keeps an unavailable model's saved effort read-only", () => {
    const missing = row(OPENCODE, OPENCODE_DRIVER, "openrouter/missing", OPENCODE_MODELS);
    const state = createCombinedPickerState(
      saved({
        instanceId: OPENCODE,
        model: "openrouter/missing",
        options: selections(["variant", "low"]),
      }),
    );
    const resolved = resolveCombinedPickerRow(state, missing, CONTEXT);

    expect(resolved.effort?.value).toBe("low");
    expect(resolved.effort?.readOnlyReason).toEqual(expect.any(String));
    expect(stepCombinedPickerEffort(state, missing, CONTEXT, -1)).toBe(state);
    expect(candidateFor(state, missing).modelSelection.options).toEqual(
      selections(["variant", "low"]),
    );
  });

  it("combined picker state skips prompt-injected effort when prompts cannot change", () => {
    const settingsContext = { planModeEnabled: true, allowPromptInjectedEffort: false };
    let state = createCombinedPickerState(
      saved({
        instanceId: CLAUDE,
        model: "claude-opus-5",
        options: selections(["effort", "max"]),
      }),
    );

    state = stepCombinedPickerEffort(state, CLAUDE_OPUS, settingsContext, 1);
    expect(effortOf(state, CLAUDE_OPUS, settingsContext)).toBe("max");
    expect(resolveCombinedPickerRow(state, CLAUDE_OPUS, settingsContext).effort?.canIncrease).toBe(
      false,
    );
  });
});

describe("combinedPickerState candidates", () => {
  it("combined picker state builds a complete candidate with the row's explicit options", () => {
    let state = createCombinedPickerState(
      saved({
        options: selections(["reasoningEffort", "high"], ["serviceTier", "priority"]),
      }),
    );
    state = step(state, CODEX_55, -1);

    const candidate = candidateFor(state, CODEX_55);
    expect(candidate.modelSelection).toEqual({
      instanceId: CODEX,
      model: "gpt-5.5",
      options: selections(["reasoningEffort", "low"]),
    });
    expect(candidate.prompt).toBe("Draft");
    expect(candidate.runtimeMode).toBeUndefined();
  });

  it("combined picker state edits More options values without touching effort", () => {
    let state = createCombinedPickerState(
      saved({ options: selections(["reasoningEffort", "high"]) }),
    );
    state = setCombinedPickerOption(state, CODEX_54, CONTEXT, "serviceTier", "priority");

    expect(effortOf(state, CODEX_54)).toBe("high");
    const options = candidateFor(state, CODEX_54).modelSelection.options;
    expect(options).toEqual(
      expect.arrayContaining([
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ]),
    );
    expect(options).toHaveLength(2);
  });

  it("combined picker state applies pending access only through the candidate", () => {
    const initial = createCombinedPickerState(saved());
    const next = setCombinedPickerRuntimeMode(initial, "full-access" satisfies RuntimeMode);

    expect(initial.runtimeMode).toBe("approval-required");
    expect(candidateFor(next, CODEX_54).runtimeMode).toBe("full-access");
  });

  it("combined picker state stages the Ultrathink prefix against the prompt current at apply time", () => {
    let state = createCombinedPickerState(
      saved({
        instanceId: CLAUDE,
        model: "claude-opus-5",
        options: selections(["effort", "max"]),
      }),
    );
    state = step(state, CLAUDE_OPUS, 1);

    expect(effortOf(state, CLAUDE_OPUS)).toBe("ultrathink");
    const candidate = candidateFor(state, CLAUDE_OPUS, CONTEXT, "Draft with newer text");
    expect(candidate.prompt).toBe("Ultrathink:\nDraft with newer text");
    expect(candidate.modelSelection.options).not.toEqual(
      expect.arrayContaining([{ id: "effort", value: "ultrathink" }]),
    );
  });

  it("combined picker state removes the Ultrathink prefix when effort leaves it", () => {
    let state = createCombinedPickerState(
      saved({ instanceId: CLAUDE, model: "claude-opus-5", prompt: "Ultrathink:\nDraft" }),
    );
    expect(effortOf(state, CLAUDE_OPUS)).toBe("ultrathink");

    state = step(state, CLAUDE_OPUS, -1);
    const candidate = candidateFor(state, CLAUDE_OPUS, CONTEXT, "Ultrathink:\nDraft edited");
    expect(candidate.prompt).toBe("Draft edited");
    expect(candidate.modelSelection.options).toEqual(
      expect.arrayContaining([{ id: "effort", value: "max" }]),
    );
  });

  it("combined picker state blocks effort while the prompt body contains ultrathink", () => {
    const state = createCombinedPickerState(
      saved({ instanceId: CLAUDE, model: "claude-opus-5", prompt: "Please ultrathink this" }),
    );
    const resolved = resolveCombinedPickerRow(state, CLAUDE_OPUS, CONTEXT);

    expect(resolved.effort?.readOnlyReason).toMatch(/ultrathink/i);
    expect(stepCombinedPickerEffort(state, CLAUDE_OPUS, CONTEXT, -1)).toBe(state);
    expect(candidateFor(state, CLAUDE_OPUS, CONTEXT, "Please ultrathink this").prompt).toBe(
      "Please ultrathink this",
    );
  });

  it("combined picker state blocks a staged effort the prompt now pins at apply time", () => {
    // Regression: leaving Ultrathink was checked only against the opening
    // prompt, so text added later that says "ultrathink" was overridden.
    let state = createCombinedPickerState(
      saved({ instanceId: CLAUDE, model: "claude-opus-5", prompt: "Ultrathink:\nDraft" }),
    );
    state = step(state, CLAUDE_OPUS, -1);

    const candidate = candidateFor(
      state,
      CLAUDE_OPUS,
      CONTEXT,
      "Ultrathink:\nPlease ultrathink the newly added text",
    );
    expect(candidate.blockedReason).toMatch(/ultrathink/i);
  });

  it("combined picker state lets other options apply while the prompt pins effort", () => {
    const claudeWithContext = row(CLAUDE, CLAUDE_DRIVER, "claude-opus-5", [
      model("claude-opus-5", [
        ...(CLAUDE_MODELS[0]!.capabilities?.optionDescriptors ?? []),
        select("contextWindow", [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ]),
      ]),
    ]);
    let state = createCombinedPickerState(
      saved({ instanceId: CLAUDE, model: "claude-opus-5", prompt: "Draft" }),
    );
    state = setCombinedPickerOption(state, claudeWithContext, CONTEXT, "contextWindow", "200k");

    const candidate = candidateFor(
      state,
      claudeWithContext,
      CONTEXT,
      "Please ultrathink the newly added text",
    );
    expect(candidate.blockedReason).toBeUndefined();
    expect(candidate.prompt).toBe("Please ultrathink the newly added text");
    expect(candidate.modelSelection.options).toEqual(
      expect.arrayContaining([{ id: "contextWindow", value: "200k" }]),
    );
  });
});

describe("combinedPickerState Settings support", () => {
  it("combined picker state reports whether a candidate edits the saved selection", () => {
    const state = createCombinedPickerState(
      saved({ options: selections(["reasoningEffort", "high"]) }),
    );

    expect(candidateFor(state, CODEX_54).selectionEdited).toBe(false);
    expect(candidateFor(state, CODEX_55).selectionEdited).toBe(true);
    expect(candidateFor(step(state, CODEX_54, -1), CODEX_54).selectionEdited).toBe(true);
    expect(
      candidateFor(setCombinedPickerRuntimeMode(state, "full-access"), CODEX_54).selectionEdited,
    ).toBe(false);
  });

  it("combined picker state marks only edited options as needing a write", () => {
    const state = createCombinedPickerState(
      saved({ options: selections(["reasoningEffort", "high"]) }),
    );

    expect(candidateFor(state, CODEX_55).optionsEdited).toBe(false);
    expect(candidateFor(step(state, CODEX_55, 1), CODEX_55).optionsEdited).toBe(true);
    expect(candidateFor(state, CODEX_55).driverKind).toBe(CODEX_DRIVER);
  });

  it("combined picker state hands the composer every option value the row shows", () => {
    // The composer writes this complete set on a model change, so an optionless
    // draft entry cannot inherit the previous model's options.
    const state = createCombinedPickerState(
      saved({ options: selections(["reasoningEffort", "high"]) }),
    );

    expect(candidateFor(state, CODEX_55).completeOptions).toEqual(
      selections(["reasoningEffort", "medium"]),
    );
    expect(candidateFor(state, CODEX_54).completeOptions).toEqual(
      selections(["reasoningEffort", "high"], ["serviceTier", "default"]),
    );
  });

  it("combined picker state applies a context's read-only option rule without hiding the option", () => {
    const context = {
      ...CONTEXT,
      optionReadOnlyReason: (_driverKind: ProviderDriverKind, descriptorId: string) =>
        descriptorId === "serviceTier" ? "Not used by this task." : null,
    };
    const state = createCombinedPickerState(saved());
    const resolved = resolveCombinedPickerRow(state, CODEX_54, context);

    expect(resolved.optionState.extraDescriptors.map((descriptor) => descriptor.id)).toContain(
      "serviceTier",
    );
    expect(resolved.optionReadOnlyReasons).toEqual({ serviceTier: "Not used by this task." });
    expect(setCombinedPickerOption(state, CODEX_54, context, "serviceTier", "priority")).toBe(
      state,
    );
    expect(effortOf(step(state, CODEX_54, 1), CODEX_54)).toBe("high");
  });
});
