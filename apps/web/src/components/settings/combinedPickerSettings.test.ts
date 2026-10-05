import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  buildCombinedPickerCandidate,
  createCombinedPickerState,
  resolveCombinedPickerRow,
  setCombinedPickerOption,
  setCombinedPickerRuntimeMode,
  stepCombinedPickerEffort,
  type CombinedPickerCandidate,
  type CombinedPickerRowInput,
  type CombinedPickerSavedSelection,
} from "../chat/combinedPickerState";
import {
  SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL,
  createSettingsPickerContext,
  getWritingSettingsOptionReadOnlyReason,
  keepLegacyCodexFast,
  planSettingsPickerApply,
  presentLegacyCodexFast,
  retainUnadvertisedSavedOptions,
  withStoredOptions,
} from "./combinedPickerSettings";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

function select(id: string, values: ReadonlyArray<string>): SelectDescriptor {
  return {
    id,
    label: id,
    type: "select",
    options: values.map((value, index) => ({
      id: value,
      label: value,
      ...(index === 0 ? { isDefault: true } : {}),
    })),
  };
}

function boolean(id: string): ProviderOptionDescriptor {
  return { id, label: id, type: "boolean", currentValue: false };
}

function model(slug: string, descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: { optionDescriptors: [...descriptors] },
  } satisfies ServerProviderModel;
}

interface ApplicabilityCase {
  name: string;
  driver: string;
  consumed: ReadonlyArray<ProviderOptionDescriptor>;
  unconsumed: ProviderOptionDescriptor;
}

/**
 * One case per driver: the descriptors its text-generation service reads, and
 * one advertised descriptor it does not read.
 */
const APPLICABILITY_CASES: ReadonlyArray<ApplicabilityCase> = [
  {
    name: "Codex",
    driver: "codex",
    consumed: [
      select("reasoningEffort", ["medium", "high"]),
      select("serviceTier", ["default", "priority"]),
      boolean("fastMode"),
    ],
    unconsumed: select("contextWindow", ["272k", "1m"]),
  },
  {
    name: "Claude",
    driver: "claudeAgent",
    consumed: [
      select("effort", ["medium", "high"]),
      boolean("thinking"),
      boolean("fastMode"),
      select("contextWindow", ["200k", "1m"]),
    ],
    unconsumed: select("agent", ["default", "reviewer"]),
  },
  {
    name: "Cursor",
    driver: "cursor",
    consumed: [
      select("reasoning", ["medium", "high"]),
      select("contextWindow", ["200k", "1m"]),
      boolean("fastMode"),
      boolean("thinking"),
    ],
    unconsumed: select("mode", ["agent", "ask"]),
  },
  {
    name: "Grok",
    driver: "grok",
    consumed: [select("reasoningEffort", ["low", "high"])],
    unconsumed: boolean("fastMode"),
  },
  {
    name: "OpenCode",
    driver: "opencode",
    consumed: [select("variant", ["max", "low"]), select("agent", ["build", "review"])],
    unconsumed: boolean("thinking"),
  },
  {
    name: "Antigravity",
    driver: "antigravity",
    consumed: [],
    unconsumed: boolean("thinking"),
  },
];

const WRITING_KINDS = ["text-generation", "source-control-writing"] as const;

function rowFor(testCase: ApplicabilityCase): CombinedPickerRowInput {
  return {
    instanceId: ProviderInstanceId.make(testCase.driver),
    driverKind: ProviderDriverKind.make(testCase.driver),
    model: "fixture-model",
    models: [model("fixture-model", [...testCase.consumed, testCase.unconsumed])],
  };
}

function savedFor(
  row: CombinedPickerRowInput,
  overrides: Partial<CombinedPickerSavedSelection> = {},
): CombinedPickerSavedSelection {
  return {
    instanceId: row.instanceId,
    model: row.model,
    modelOptionsByInstance: {},
    prompt: "",
    runtimeMode: "full-access",
    ...overrides,
  };
}

function alternateValue(descriptor: ProviderOptionDescriptor): string | boolean {
  return descriptor.type === "boolean" ? true : descriptor.options[1]!.id;
}

describe("settings picker descriptor applicability", () => {
  it.each(APPLICABILITY_CASES)(
    "settings picker applicability guard: $name writing settings edit consumed options and keep an unconsumed one visible read-only",
    (testCase) => {
      const row = rowFor(testCase);
      const driverKind = ProviderDriverKind.make(testCase.driver);
      for (const descriptor of testCase.consumed) {
        expect(getWritingSettingsOptionReadOnlyReason(driverKind, descriptor.id)).toBeNull();
      }
      expect(getWritingSettingsOptionReadOnlyReason(driverKind, testCase.unconsumed.id)).toEqual(
        expect.any(String),
      );

      for (const kind of WRITING_KINDS) {
        const context = createSettingsPickerContext(kind, { planModeEnabled: true });
        const state = createCombinedPickerState(savedFor(row));
        const resolved = resolveCombinedPickerRow(state, row, context);
        expect(resolved.optionState.descriptors.map((descriptor) => descriptor.id)).toContain(
          testCase.unconsumed.id,
        );
        expect(resolved.optionReadOnlyReasons[testCase.unconsumed.id]).toEqual(expect.any(String));
        expect(
          setCombinedPickerOption(
            state,
            row,
            context,
            testCase.unconsumed.id,
            alternateValue(testCase.unconsumed),
          ),
        ).toBe(state);
        for (const descriptor of testCase.consumed) {
          expect(resolved.optionReadOnlyReasons[descriptor.id]).toBeUndefined();
          expect(
            setCombinedPickerOption(state, row, context, descriptor.id, alternateValue(descriptor)),
          ).not.toBe(state);
        }
      }
    },
  );

  it("settings picker applicability guard: Antigravity writing settings have no inline effort", () => {
    const row = rowFor(APPLICABILITY_CASES.find((entry) => entry.driver === "antigravity")!);
    const context = createSettingsPickerContext("source-control-writing", {
      planModeEnabled: false,
    });
    const state = createCombinedPickerState(savedFor(row));
    expect(resolveCombinedPickerRow(state, row, context).effort).toBeNull();
    expect(stepCombinedPickerEffort(state, row, context, 1)).toBe(state);
  });

  it("settings picker: new-thread defaults keep every advertised option editable", () => {
    const codex = APPLICABILITY_CASES[0]!;
    const row = rowFor(codex);
    const context = createSettingsPickerContext("new-thread-defaults", { planModeEnabled: true });
    const state = createCombinedPickerState(savedFor(row));
    const resolved = resolveCombinedPickerRow(state, row, context);
    expect(resolved.optionReadOnlyReasons).toEqual({});
    expect(setCombinedPickerOption(state, row, context, "contextWindow", "1m")).not.toBe(state);
  });

  it("settings picker: every Settings context shows Ultrathink disabled and never stages a prompt", () => {
    const row: CombinedPickerRowInput = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      model: "claude-opus-5",
      models: [
        model("claude-opus-5", [
          {
            ...select("effort", ["medium", "high", "ultrathink"]),
            promptInjectedValues: ["ultrathink"],
          },
        ]),
      ],
    };
    for (const kind of ["new-thread-defaults", ...WRITING_KINDS] as const) {
      const context = createSettingsPickerContext(kind, { planModeEnabled: false });
      expect(context.allowPromptInjectedEffort).toBe(false);
      const state = createCombinedPickerState(savedFor(row));
      const effort = resolveCombinedPickerRow(state, row, context).effort;
      expect(effort?.options.find((option) => option.id === "ultrathink")).toMatchObject({
        disabled: true,
      });
      expect(setCombinedPickerOption(state, row, context, "effort", "ultrathink")).toBe(state);
      const stepped = stepCombinedPickerEffort(
        stepCombinedPickerEffort(state, row, context, 1),
        row,
        context,
        1,
      );
      const candidate = buildCombinedPickerCandidate(stepped, row, context, "");
      expect(candidate.prompt).toBe("");
      expect(candidate.modelSelection.options).toEqual([{ id: "effort", value: "high" }]);
    }
  });

  it("settings picker: writing contexts show access as managed by the task", () => {
    expect(SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL).toBe("Managed by task");
    for (const kind of WRITING_KINDS) {
      expect(
        createSettingsPickerContext(kind, { planModeEnabled: false }).accessReadOnlyLabel,
      ).toBe(SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL);
    }
    expect(
      createSettingsPickerContext("new-thread-defaults", { planModeEnabled: false })
        .accessReadOnlyLabel,
    ).toBeUndefined();
  });
});

const CODEX = ProviderInstanceId.make("codex");
const GPT_54: ModelSelection = {
  instanceId: CODEX,
  model: "gpt-5.4",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "contextWindow", value: "1m" },
  ],
};

function candidate(overrides: Partial<CombinedPickerCandidate> = {}): CombinedPickerCandidate {
  return {
    modelSelection: GPT_54,
    prompt: "",
    selectionEdited: false,
    appliedFrom: "use",
    ...overrides,
  };
}

const ACCEPT = () => null;
const REJECT = () => "This model is unavailable on Server.";

describe("settings picker apply plans", () => {
  it("settings picker: a model choice writes only the complete model selection", () => {
    expect(
      planSettingsPickerApply({
        kind: "new-thread-defaults",
        candidate: candidate({ appliedFrom: "row" }),
        getModelDisabledReason: ACCEPT,
      }),
    ).toEqual({ kind: "write", modelSelection: GPT_54 });
  });

  it("settings picker: an access-only edit writes only access and keeps a Mixed model", () => {
    expect(
      planSettingsPickerApply({
        kind: "new-thread-defaults",
        candidate: candidate({ runtimeMode: "approval-required" }),
        getModelDisabledReason: REJECT,
      }),
    ).toEqual({ kind: "write", runtimeMode: "approval-required" });
  });

  it("settings picker: an edited selection applied with access writes both fields", () => {
    expect(
      planSettingsPickerApply({
        kind: "new-thread-defaults",
        candidate: candidate({ selectionEdited: true, runtimeMode: "auto" }),
        getModelDisabledReason: ACCEPT,
      }),
    ).toEqual({ kind: "write", modelSelection: GPT_54, runtimeMode: "auto" });
  });

  it("settings picker: an untouched opening plans no write", () => {
    expect(
      planSettingsPickerApply({
        kind: "new-thread-defaults",
        candidate: candidate(),
        getModelDisabledReason: ACCEPT,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("settings picker: a model missing on one environment rejects the whole candidate", () => {
    expect(
      planSettingsPickerApply({
        kind: "new-thread-defaults",
        candidate: candidate({ appliedFrom: "row", runtimeMode: "auto" }),
        getModelDisabledReason: REJECT,
      }),
    ).toEqual({ kind: "rejected", reason: "This model is unavailable on Server." });
  });

  it("settings picker: a blocked candidate is rejected with its reason", () => {
    expect(
      planSettingsPickerApply({
        kind: "text-generation",
        candidate: candidate({ appliedFrom: "row", blockedReason: "Blocked." }),
        getModelDisabledReason: ACCEPT,
      }),
    ).toEqual({ kind: "rejected", reason: "Blocked." });
  });

  it("settings picker: writing contexts never write access", () => {
    for (const kind of WRITING_KINDS) {
      expect(
        planSettingsPickerApply({
          kind,
          candidate: candidate({ appliedFrom: "row", runtimeMode: "auto" }),
          getModelDisabledReason: ACCEPT,
        }),
      ).toEqual({ kind: "write", modelSelection: GPT_54 });
      expect(
        planSettingsPickerApply({
          kind,
          candidate: candidate({ runtimeMode: "auto" }),
          getModelDisabledReason: ACCEPT,
        }),
      ).toEqual({ kind: "unchanged" });
    }
  });

  it("settings picker: applying keeps saved options the row did not edit", () => {
    const row = rowFor(APPLICABILITY_CASES[0]!);
    const context = createSettingsPickerContext("source-control-writing", {
      planModeEnabled: false,
    });
    const state = createCombinedPickerState(
      savedFor(row, {
        modelOptionsByInstance: {
          [row.instanceId]: [
            { id: "reasoningEffort", value: "medium" },
            { id: "contextWindow", value: "1m" },
          ],
        },
      }),
    );
    const edited = stepCombinedPickerEffort(state, row, context, 1);
    const built = buildCombinedPickerCandidate(edited, row, context, "");
    expect(built.selectionEdited).toBe(true);
    const plan = planSettingsPickerApply({
      kind: "source-control-writing",
      candidate: { ...built, appliedFrom: "use" },
      getModelDisabledReason: ACCEPT,
    });
    expect(plan).toMatchObject({ kind: "write" });
    expect(plan.kind === "write" ? plan.modelSelection?.options : undefined).toEqual(
      expect.arrayContaining([
        { id: "reasoningEffort", value: "high" },
        { id: "contextWindow", value: "1m" },
      ]),
    );
  });

  it("settings picker: a dismissed opening leaves the next opening with nothing to write", () => {
    const row = rowFor(APPLICABILITY_CASES[0]!);
    const context = createSettingsPickerContext("new-thread-defaults", { planModeEnabled: false });
    const saved = savedFor(row);
    const dismissed = setCombinedPickerRuntimeMode(
      stepCombinedPickerEffort(createCombinedPickerState(saved), row, context, 1),
      "auto",
    );
    expect(dismissed.rowEdits.size).toBe(1);

    const reopened = createCombinedPickerState(saved);
    const built = buildCombinedPickerCandidate(reopened, row, context, "");
    expect(built.runtimeMode).toBeUndefined();
    expect(
      planSettingsPickerApply({
        kind: "new-thread-defaults",
        candidate: { ...built, appliedFrom: "use" },
        getModelDisabledReason: ACCEPT,
      }),
    ).toEqual({ kind: "unchanged" });
  });
});

describe("settings picker unadvertised saved options", () => {
  const LEGACY_FAST: ModelSelection = {
    instanceId: CODEX,
    model: "gpt-5.4",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
  };
  const ADVERTISED = new Set(["reasoningEffort", "serviceTier"]);

  it("settings picker: reapplying the saved model keeps a legacy option it does not advertise", () => {
    const applied: ModelSelection = {
      instanceId: CODEX,
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(retainUnadvertisedSavedOptions(applied, LEGACY_FAST, ADVERTISED).options).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("settings picker: an advertised option the edit cleared is not restored from the saved value", () => {
    const saved: ModelSelection = {
      instanceId: CODEX,
      model: "gpt-5.4",
      options: [{ id: "serviceTier", value: "priority" }],
    };
    const applied: ModelSelection = { instanceId: CODEX, model: "gpt-5.4", options: [] };
    expect(retainUnadvertisedSavedOptions(applied, saved, ADVERTISED)).toBe(applied);
  });

  it("settings picker: choosing another model drops the previous model's saved options", () => {
    const applied: ModelSelection = { instanceId: CODEX, model: "gpt-5.5" };
    expect(retainUnadvertisedSavedOptions(applied, LEGACY_FAST, ADVERTISED)).toBe(applied);
  });
});

describe("settings picker legacy Codex Fast", () => {
  const CODEX_DRIVER = ProviderDriverKind.make("codex");
  const tiers = (options: ReadonlyArray<{ id: string; label: string }>) => [
    model("gpt-5.4", [
      select("reasoningEffort", ["low", "medium"]),
      { id: "serviceTier", label: "Service tier", type: "select", options: [...options] },
    ]),
  ];
  const legacy = (extra: ModelSelection["options"] = []): ModelSelection => ({
    instanceId: CODEX,
    model: "gpt-5.4",
    options: [{ id: "fastMode", value: true }, ...(extra ?? [])],
  });
  const STANDARD = { id: "default", label: "Standard" };

  const tierOf = (models: ReturnType<typeof tiers>, selection = legacy()) =>
    presentLegacyCodexFast({ driverKind: CODEX_DRIVER, models, selection })?.tier ?? null;

  it("settings picker: legacy Fast resolves to the advertised fast tier", () => {
    expect(tierOf(tiers([STANDARD, { id: "fast", label: "Fast" }]))).toBe("fast");
    expect(tierOf(tiers([STANDARD, { id: "priority", label: "Fast" }]))).toBe("priority");
  });

  it("settings picker: an explicit service tier wins over legacy Fast", () => {
    expect(
      tierOf(
        tiers([STANDARD, { id: "fast", label: "Fast" }]),
        legacy([{ id: "serviceTier", value: "default" }]),
      ),
    ).toBeNull();
    expect(
      presentLegacyCodexFast({
        driverKind: ProviderDriverKind.make("claudeAgent"),
        models: tiers([STANDARD, { id: "fast", label: "Fast" }]),
        selection: legacy(),
      }),
    ).toBeNull();
  });

  it("settings picker: unadvertised legacy Fast gets a selected display-only tier on its model only", () => {
    const models = [
      ...tiers([STANDARD, { id: "flex", label: "Flex" }]),
      model("gpt-5.5", [
        { id: "serviceTier", label: "Service tier", type: "select", options: [STANDARD] },
      ]),
    ];
    const presented = presentLegacyCodexFast({
      driverKind: CODEX_DRIVER,
      models,
      selection: legacy(),
    });
    expect(presented?.tier).toBe("fast");
    expect(presented?.shown.options).toContainEqual({ id: "serviceTier", value: "fast" });
    const tierOptions = (slug: string) => {
      const descriptor = presented?.models
        .find((candidate) => candidate.slug === slug)
        ?.capabilities?.optionDescriptors?.find((candidate) => candidate.id === "serviceTier");
      return descriptor?.type === "select" ? descriptor.options.map((option) => option.label) : [];
    };
    expect(tierOptions("gpt-5.4")).toEqual(["Standard", "Flex", "Fast (legacy)"]);
    expect(tierOptions("gpt-5.5")).toEqual(["Standard"]);
    // The display-only tier is never saved: applying it keeps the stored form.
    const applied: ModelSelection = {
      ...legacy(),
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    expect(keepLegacyCodexFast(applied, legacy(), "fast").options).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "fastMode", value: true },
    ]);
  });

  it("settings picker: legacy Fast keeps its stored form when the seeded tier is applied", () => {
    const stored = legacy([{ id: "reasoningEffort", value: "low" }]);
    const applied: ModelSelection = {
      ...stored,
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    expect(keepLegacyCodexFast(applied, stored, "fast").options).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "fastMode", value: true },
    ]);
  });

  it("settings picker: choosing Standard over legacy Fast writes the explicit tier", () => {
    const stored = legacy();
    const applied: ModelSelection = {
      ...stored,
      options: [{ id: "serviceTier", value: "default" }],
    };
    expect(keepLegacyCodexFast(applied, stored, "fast")).toBe(applied);
  });

  it("settings picker: the stored options return only while the resolved selection names them", () => {
    const resolved: ModelSelection = { instanceId: CODEX, model: "gpt-5.4", options: [] };
    expect(withStoredOptions(resolved, legacy()).options).toEqual(legacy().options);
    expect(withStoredOptions(resolved, { ...legacy(), model: "gpt-5.5" })).toBe(resolved);
    expect(withStoredOptions(resolved, null)).toBe(resolved);
  });
});
