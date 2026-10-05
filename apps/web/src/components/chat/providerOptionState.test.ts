import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  applyProviderOptionChange,
  getInlineEffortDescriptorId,
  resolveProviderOptionState,
} from "./providerOptionState";

// Descriptor shapes follow the provider snapshots the server publishes:
// CodexProvider, ClaudeModelCatalog, CursorProvider, GrokProvider, and
// OpenCodeProvider. Antigravity publishes no option descriptors.

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

function select(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  extra: Partial<SelectDescriptor> = {},
): SelectDescriptor {
  return { id, label, type: "select", options: [...options], ...extra };
}

function toggle(id: string, label: string, currentValue?: boolean): BooleanDescriptor {
  return {
    id,
    label,
    type: "boolean",
    ...(currentValue === undefined ? {} : { currentValue }),
  };
}

function catalog(
  slug: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug, name: slug, isCustom: false, capabilities: { optionDescriptors: [...descriptors] } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const GROK = ProviderDriverKind.make("grok");
const OPENCODE = ProviderDriverKind.make("opencode");
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");

const CODEX_REASONING = select("reasoningEffort", "Reasoning", [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
]);
const CODEX_SERVICE_TIER = select("serviceTier", "Service tier", [
  { id: "default", label: "Standard", isDefault: true },
  { id: "priority", label: "Fast" },
]);
const CLAUDE_EFFORT = select(
  "effort",
  "Reasoning",
  [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  { promptInjectedValues: ["ultrathink"] },
);
const CLAUDE_CONTEXT_WINDOW = select("contextWindow", "Context Window", [
  { id: "200k", label: "200k" },
  { id: "1m", label: "1M", isDefault: true },
]);
const OPENCODE_AGENT = select("agent", "Agent", [
  { id: "build", label: "Build", isDefault: true },
  { id: "plan", label: "Plan" },
]);
const OPENCODE_VARIANT = select("variant", "Reasoning", [
  { id: "max", label: "Max" },
  { id: "custom-deep", label: "Custom deep" },
  { id: "low", label: "Low", isDefault: true },
]);

function state(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  modelOptions?: ReadonlyArray<ProviderOptionSelection>;
  prompt?: string;
  planModeEnabled?: boolean;
  allowPromptInjectedEffort?: boolean;
  models?: ReadonlyArray<ServerProviderModel>;
  model?: string;
}) {
  return resolveProviderOptionState({
    provider: input.provider,
    models: input.models ?? catalog("model", input.descriptors),
    model: input.model ?? "model",
    prompt: input.prompt ?? "",
    modelOptions: input.modelOptions,
    planModeEnabled: input.planModeEnabled ?? true,
    ...(input.allowPromptInjectedEffort === undefined
      ? {}
      : { allowPromptInjectedEffort: input.allowPromptInjectedEffort }),
  });
}

describe("providerOptionState inline effort descriptor", () => {
  it("providerOptionState Codex uses reasoningEffort inline and keeps service tier as an extra", () => {
    const resolved = state({ provider: CODEX, descriptors: [CODEX_REASONING, CODEX_SERVICE_TIER] });

    expect(getInlineEffortDescriptorId(CODEX)).toBe("reasoningEffort");
    expect(resolved.effortDescriptor?.id).toBe("reasoningEffort");
    expect(resolved.effortDescriptor?.options.map((option) => option.label)).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra High",
    ]);
    expect(resolved.extraDescriptors.map((descriptor) => descriptor.id)).toEqual(["serviceTier"]);
  });

  it("providerOptionState Claude uses effort inline and reports Ultrathink from the prompt prefix", () => {
    const resolved = state({
      provider: CLAUDE,
      descriptors: [CLAUDE_EFFORT, CLAUDE_CONTEXT_WINDOW],
      prompt: "Ultrathink:\nFix the flaky test",
    });

    expect(getInlineEffortDescriptorId(CLAUDE)).toBe("effort");
    expect(resolved.effortDescriptor?.id).toBe("effort");
    expect(resolved.effort).toBe("ultrathink");
    expect(resolved.ultrathinkPromptControlled).toBe(true);
    expect(resolved.ultrathinkInBodyText).toBe(false);
    expect(resolved.extraDescriptors.map((descriptor) => descriptor.id)).toEqual(["contextWindow"]);
  });

  it("providerOptionState Cursor uses reasoning inline even when another select comes first", () => {
    const resolved = state({
      provider: CURSOR,
      descriptors: [
        CLAUDE_CONTEXT_WINDOW,
        select("reasoning", "Reasoning", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        toggle("fastMode", "Fast Mode", false),
        toggle("thinking", "Thinking", true),
      ],
    });

    expect(getInlineEffortDescriptorId(CURSOR)).toBe("reasoning");
    expect(resolved.effortDescriptor?.id).toBe("reasoning");
    expect(resolved.extraDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "contextWindow",
      "fastMode",
      "thinking",
    ]);
  });

  it("providerOptionState Grok uses reasoningEffort inline with no extras", () => {
    const resolved = state({
      provider: GROK,
      descriptors: [
        select("reasoningEffort", "Reasoning", [
          { id: "low", label: "Low", isDefault: true },
          { id: "high", label: "High" },
        ]),
      ],
    });

    expect(getInlineEffortDescriptorId(GROK)).toBe("reasoningEffort");
    expect(resolved.effortDescriptor?.id).toBe("reasoningEffort");
    expect(resolved.extraDescriptors).toEqual([]);
  });

  it("providerOptionState OpenCode uses variant inline in metadata order and keeps agent as an extra", () => {
    const resolved = state({
      provider: OPENCODE,
      descriptors: [OPENCODE_AGENT, OPENCODE_VARIANT],
      modelOptions: selections(["variant", "custom-deep"]),
    });

    expect(getInlineEffortDescriptorId(OPENCODE)).toBe("variant");
    expect(resolved.effortDescriptor?.id).toBe("variant");
    expect(resolved.effortDescriptor?.options.map((option) => option.id)).toEqual([
      "max",
      "custom-deep",
      "low",
    ]);
    expect(resolved.effort).toBe("custom-deep");
    expect(resolved.extraDescriptors.map((descriptor) => descriptor.id)).toEqual(["agent"]);
  });

  it("providerOptionState Antigravity has no inline effort and no controls", () => {
    const resolved = state({ provider: ANTIGRAVITY, descriptors: [] });

    expect(getInlineEffortDescriptorId(ANTIGRAVITY)).toBeNull();
    expect(resolved.effortDescriptor).toBeNull();
    expect(resolved.extraDescriptors).toEqual([]);
    expect(resolved.hasAnyControls).toBe(false);
  });

  it("providerOptionState gives no inline effort to a model without its provider's effort descriptor", () => {
    const resolved = state({ provider: CODEX, descriptors: [CODEX_SERVICE_TIER] });

    expect(resolved.effortDescriptor).toBeNull();
    expect(resolved.extraDescriptors.map((descriptor) => descriptor.id)).toEqual(["serviceTier"]);
  });
});

describe("providerOptionState saved values and filters", () => {
  it("providerOptionState keeps saved values of an unavailable OpenCode model read-only", () => {
    const resolved = state({
      provider: OPENCODE,
      descriptors: [OPENCODE_AGENT, OPENCODE_VARIANT],
      models: catalog("other/model", [OPENCODE_AGENT, OPENCODE_VARIANT]),
      model: "missing/model",
      modelOptions: selections(["variant", "max"], ["agent", "build"]),
    });

    expect(resolved.modelIsUnavailable).toBe(true);
    expect(resolved.effortDescriptor?.id).toBe("variant");
    expect(resolved.effort).toBe("max");
    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "variant",
        value: "low",
        prompt: "",
      }),
    ).toBeNull();
  });

  it("providerOptionState removes the plan agent when plan mode is disabled", () => {
    const resolved = state({
      provider: OPENCODE,
      descriptors: [OPENCODE_AGENT, OPENCODE_VARIANT],
      planModeEnabled: false,
    });

    const agent = resolved.extraDescriptors.find((descriptor) => descriptor.id === "agent");
    expect(agent?.type === "select" ? agent.options.map((option) => option.id) : null).toEqual([
      "build",
    ]);
  });

  it("providerOptionState ignores a body-text ultrathink when prompts cannot change", () => {
    const resolved = state({
      provider: CLAUDE,
      descriptors: [CLAUDE_EFFORT],
      prompt: "Ultrathink:\nPlease ultrathink about this",
      modelOptions: selections(["effort", "high"]),
      allowPromptInjectedEffort: false,
    });

    expect(resolved.ultrathinkPromptControlled).toBe(false);
    expect(resolved.effort).toBe("high");
  });
});

describe("providerOptionState option changes", () => {
  it("providerOptionState replaces one select value and keeps the other descriptors' values", () => {
    const resolved = state({
      provider: CODEX,
      descriptors: [CODEX_REASONING, CODEX_SERVICE_TIER],
      modelOptions: selections(["serviceTier", "priority"]),
    });

    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "reasoningEffort",
        value: "xhigh",
        prompt: "Keep",
      }),
    ).toEqual({
      prompt: "Keep",
      modelOptionsChanged: true,
      modelOptions: selections(["reasoningEffort", "xhigh"], ["serviceTier", "priority"]),
    });
  });

  it("providerOptionState changes a boolean option", () => {
    const resolved = state({
      provider: CURSOR,
      descriptors: [toggle("fastMode", "Fast Mode", false)],
    });

    expect(
      applyProviderOptionChange(resolved, { descriptorId: "fastMode", value: true, prompt: "" }),
    ).toEqual({
      prompt: "",
      modelOptionsChanged: true,
      modelOptions: selections(["fastMode", true]),
    });
  });

  it("providerOptionState applies Claude Ultrathink by prefixing the prompt only", () => {
    const resolved = state({
      provider: CLAUDE,
      descriptors: [CLAUDE_EFFORT],
      modelOptions: selections(["effort", "max"]),
    });

    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "effort",
        value: "ultrathink",
        prompt: "Fix the flaky test",
      }),
    ).toEqual({ prompt: "Ultrathink:\nFix the flaky test", modelOptionsChanged: false });
    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "effort",
        value: "ultrathink",
        prompt: "",
      }),
    ).toEqual({ prompt: "Ultrathink:\n", modelOptionsChanged: false });
  });

  it("providerOptionState leaving Ultrathink strips only the prefix and saves the new effort", () => {
    const resolved = state({
      provider: CLAUDE,
      descriptors: [CLAUDE_EFFORT],
      prompt: "Ultrathink:\nFix the flaky test",
    });

    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "effort",
        value: "high",
        prompt: "Ultrathink:\nFix the flaky test",
      }),
    ).toEqual({
      prompt: "Fix the flaky test",
      modelOptionsChanged: true,
      modelOptions: selections(["effort", "high"]),
    });
  });

  it("providerOptionState blocks effort changes while the prompt body says ultrathink", () => {
    const resolved = state({
      provider: CLAUDE,
      descriptors: [CLAUDE_EFFORT, CLAUDE_CONTEXT_WINDOW],
      prompt: "Please ultrathink about this",
    });

    expect(resolved.ultrathinkInBodyText).toBe(true);
    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "effort",
        value: "low",
        prompt: "Please ultrathink about this",
      }),
    ).toBeNull();
    expect(
      applyProviderOptionChange(resolved, {
        descriptorId: "contextWindow",
        value: "200k",
        prompt: "Please ultrathink about this",
      })?.modelOptions,
    ).toEqual(selections(["effort", "medium"], ["contextWindow", "200k"]));
  });
});
