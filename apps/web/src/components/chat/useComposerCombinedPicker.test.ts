import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { CombinedPickerCandidate } from "./combinedPickerState";
import {
  applyCombinedPickerCandidateToComposer,
  isComposerRestingBlockShown,
  type ComposerPickerApplyEffects,
} from "./useComposerCombinedPicker";

const CODEX = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function candidate(overrides: Partial<CombinedPickerCandidate> = {}): CombinedPickerCandidate {
  return {
    modelSelection: {
      instanceId: CODEX,
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
    driverKind: CODEX_DRIVER,
    completeOptions: [{ id: "reasoningEffort", value: "low" }],
    prompt: "Draft",
    optionsEdited: true,
    changesModel: true,
    selectionEdited: true,
    appliedFrom: "row",
    ...overrides,
  };
}

/** Records every composer write in order. */
function recorder(input: { accepts: boolean; prompt?: string }) {
  const writes: Array<[string, ...unknown[]]> = [];
  const effects: ComposerPickerApplyEffects = {
    selectModel: (instanceId, model) => {
      writes.push(["selectModel", instanceId, model]);
      return input.accepts;
    },
    setModelOptions: (driverKind, options, target) =>
      writes.push(["setModelOptions", driverKind, options, target]),
    setRuntimeMode: (mode) => writes.push(["setRuntimeMode", mode]),
    readPrompt: () => input.prompt ?? "Draft",
    setPrompt: (prompt) => writes.push(["setPrompt", prompt]),
    clearMultipleModels: () => writes.push(["clearMultipleModels"]),
    warn: (title) => writes.push(["warn", title]),
    focusComposer: () => writes.push(["focusComposer"]),
  };
  return { effects, writes };
}

describe("applyCombinedPickerCandidateToComposer", () => {
  it("a refused model writes no option, access, prompt, or multi-model change", () => {
    const { effects, writes } = recorder({ accepts: false });

    const applied = applyCombinedPickerCandidateToComposer(
      candidate({ runtimeMode: "full-access", prompt: "Ultrathink:\nDraft" }),
      effects,
    );

    expect(applied).toBe(false);
    expect(writes).toEqual([["selectModel", CODEX, "gpt-5.5"], ["focusComposer"]]);
  });

  it("an accepted model writes its complete options, then access, then the prompt", () => {
    const { effects, writes } = recorder({ accepts: true });

    applyCombinedPickerCandidateToComposer(
      candidate({ runtimeMode: "full-access", prompt: "Ultrathink:\nDraft" }),
      effects,
    );

    expect(writes).toEqual([
      ["selectModel", CODEX, "gpt-5.5"],
      ["clearMultipleModels"],
      [
        "setModelOptions",
        CODEX_DRIVER,
        [{ id: "reasoningEffort", value: "low" }],
        { instanceId: CODEX, model: "gpt-5.5", persistSticky: true },
      ],
      ["setRuntimeMode", "full-access"],
      ["setPrompt", "Ultrathink:\nDraft"],
      ["focusComposer"],
    ]);
  });

  it("an unedited new model still pins the options its row showed, without remembering them", () => {
    const { effects, writes } = recorder({ accepts: true });

    applyCombinedPickerCandidateToComposer(candidate({ optionsEdited: false }), effects);

    expect(writes).toContainEqual([
      "setModelOptions",
      CODEX_DRIVER,
      [{ id: "reasoningEffort", value: "low" }],
      { instanceId: CODEX, model: "gpt-5.5", persistSticky: false },
    ]);
    expect(writes.find(([name]) => name === "setRuntimeMode")).toBeUndefined();
    expect(writes.find(([name]) => name === "setPrompt")).toBeUndefined();
  });

  it("the saved model applied unedited changes neither model nor options", () => {
    const { effects, writes } = recorder({ accepts: true });

    applyCombinedPickerCandidateToComposer(
      candidate({ changesModel: false, optionsEdited: false, runtimeMode: "auto" }),
      effects,
    );

    expect(writes).toEqual([
      ["clearMultipleModels"],
      ["setRuntimeMode", "auto"],
      ["focusComposer"],
    ]);
  });

  it("a prompt that pins the staged effort blocks the whole choice", () => {
    const { effects, writes } = recorder({ accepts: true });

    const applied = applyCombinedPickerCandidateToComposer(
      candidate({ blockedReason: "Remove ultrathink", runtimeMode: "auto" }),
      effects,
    );

    expect(applied).toBe(false);
    expect(writes).toEqual([["warn", "Effort is set by your prompt"], ["focusComposer"]]);
  });
});

describe("isComposerRestingBlockShown", () => {
  it("drops the separate traits block and keeps the mode block only for plan mode", () => {
    expect(isComposerRestingBlockShown("traits", { planModeUiEnabled: true })).toBe(false);
    expect(isComposerRestingBlockShown("mode", { planModeUiEnabled: true })).toBe(true);
    expect(isComposerRestingBlockShown("mode", { planModeUiEnabled: false })).toBe(false);
  });
});
