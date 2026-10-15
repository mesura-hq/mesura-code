// @vitest-environment happy-dom
/**
 * Entry point: the real CombinedPickerSettings around the real
 * ProviderModelPicker, CombinedModelPickerContent and ModelPickerContent, as
 * General Settings and Source Control mount them. Pointer and key events drive
 * the real picker; what each row receives through `onChange` is the write the
 * scoped settings would get.
 *
 * Boundaries replaced, and nothing else: router navigation, the shipped
 * keybindings (read from the server in the app), and the virtual list's
 * measurement, which happy-dom cannot do.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    ...(await original<typeof import("../../state/server")>()),
    primaryServerKeybindingsAtom: Atom.make(() => DEFAULT_RESOLVED_KEYBINDINGS),
  };
});
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: ReadonlyArray<string>;
    renderItem: (input: { item: string; index: number }) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={item}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  accessSummary,
  buttonByLabel,
  click,
  effortValue,
  extrasRegion,
  moreOptionsToggle,
  pickerContent,
  press,
  row,
  searchInput,
} from "../../test/combinedPickerDom";
import { toastManager } from "../ui/toast";
import { CombinedPickerSettings, type SettingsPickerChange } from "./CombinedPickerSettings";
import {
  SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL,
  type SettingsPickerKind,
} from "./combinedPickerSettings";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    instanceId: CODEX,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T12:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
            {
              id: "contextWindow",
              label: "Context window",
              type: "select",
              options: [
                { id: "272k", label: "272k", isDefault: true },
                { id: "1m", label: "1M" },
              ],
            },
          ],
        },
      },
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: CLAUDE,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T12:00:00.000Z",
    models: [
      {
        slug: "claude-opus-5",
        name: "Claude Opus 5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
                { id: "ultrathink", label: "Ultrathink" },
              ],
              promptInjectedValues: ["ultrathink"],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  },
];
const ENTRIES = deriveProviderInstanceEntries(PROVIDERS);
const MODEL_OPTIONS = new Map(
  ENTRIES.map((entry) => [
    entry.instanceId,
    entry.models.map((model) => ({ slug: model.slug, name: model.name })),
  ]),
);
const GPT_54: ModelSelection = {
  instanceId: CODEX,
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "high" }],
};

let root: Root | undefined;
let container: HTMLDivElement;
let changes: SettingsPickerChange[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  changes = [];
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(props: {
  kind: SettingsPickerKind;
  selection?: ModelSelection | null;
  mixedModel?: boolean;
  runtimeMode?: RuntimeMode;
  runtimeModeMixed?: boolean;
  triggerLabel?: string;
  opensOnExtras?: boolean;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
}) {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <CombinedPickerSettings
        kind={props.kind}
        selection={props.selection === undefined ? GPT_54 : props.selection}
        instanceEntries={ENTRIES}
        modelOptionsByInstance={MODEL_OPTIONS}
        planModeEnabled={false}
        mixedModel={props.mixedModel ?? false}
        {...(props.runtimeMode ? { runtimeMode: props.runtimeMode } : {})}
        {...(props.runtimeModeMixed ? { runtimeModeMixed: true } : {})}
        {...(props.triggerLabel ? { triggerLabel: props.triggerLabel } : {})}
        {...(props.opensOnExtras ? { opensOnExtras: true } : {})}
        triggerAriaLabel="Settings picker"
        rejectedTitle="Not saved"
        getModelDisabledReason={props.getModelDisabledReason ?? (() => null)}
        onChange={(change) => changes.push(change)}
      />,
    );
  });
}

async function openPicker() {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Settings picker"]');
  expect(trigger, "Expected the Settings picker trigger").toBeTruthy();
  await click(trigger!);
  expect(pickerContent(), "Expected the picker to open").toBeTruthy();
}

async function chooseOption(controlLabel: string, value: string) {
  const control = pickerContent()!.querySelector<HTMLSelectElement>(
    `select[aria-label="${controlLabel}"]`,
  );
  expect(control, `Expected the ${controlLabel} control`).toBeTruthy();
  await act(async () => {
    control!.value = value;
    control!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("combined picker in Settings: new-thread defaults", () => {
  it("settings picker shows the saved effort in the trigger", async () => {
    await render({ kind: "new-thread-defaults" });
    expect(
      container.querySelector('[data-chat-provider-model-picker-traits="true"]')?.textContent,
    ).toBe("High · 272k");
  });

  it("settings picker writes a chosen model with its effort and leaves access alone", async () => {
    await render({ kind: "new-thread-defaults", runtimeMode: "approval-required" });
    await openPicker();
    await click(buttonByLabel("Decrease effort for GPT-5.5", pickerContent()!)!);
    expect(effortValue("GPT-5.5")).toBe("Low");

    await click(row("GPT-5.5"));

    expect(changes).toEqual([
      {
        modelSelection: {
          instanceId: CODEX,
          model: "gpt-5.5",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      },
    ]);
  });

  it("settings picker Permissions row opens on More options and writes access alone", async () => {
    await render({
      kind: "new-thread-defaults",
      runtimeMode: "approval-required",
      triggerLabel: "Supervised",
      opensOnExtras: true,
    });
    await openPicker();
    expect(moreOptionsToggle()?.getAttribute("aria-expanded")).toBe("true");
    await chooseOption("Access level", "full-access");

    await click(buttonByLabel("Use GPT-5.4", extrasRegion()!)!);

    // An access edit keeps the saved, possibly inherited, model untouched.
    expect(changes).toEqual([{ runtimeMode: "full-access" }]);
  });

  it("settings picker keeps a Mixed model when only access changes", async () => {
    await render({
      kind: "new-thread-defaults",
      mixedModel: true,
      runtimeMode: "approval-required",
      runtimeModeMixed: true,
    });
    await openPicker();
    expect(accessSummary()).toContain("Mixed");
    await click(moreOptionsToggle()!);
    await chooseOption("Access level", "auto");
    await click(buttonByLabel("Use GPT-5.4", extrasRegion()!)!);

    expect(changes).toEqual([{ runtimeMode: "auto" }]);
  });

  it("settings picker applies access without any selectable provider", async () => {
    await render({
      kind: "new-thread-defaults",
      selection: null,
      runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      triggerLabel: "Full access",
      opensOnExtras: true,
    });
    await openPicker();
    expect(extrasRegion()?.textContent).toContain("No model highlighted");
    const apply = buttonByLabel(/^Apply access/, extrasRegion()!);
    expect(apply?.disabled).toBe(true);

    await chooseOption("Access level", "approval-required");
    await click(buttonByLabel(/^Apply access/, extrasRegion()!)!);

    expect(changes).toEqual([{ runtimeMode: "approval-required" }]);
  });

  it("settings picker shows Full access as the default for new threads", async () => {
    await render({
      kind: "new-thread-defaults",
      runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
    });
    await openPicker();
    expect(accessSummary()).toContain("Full access");
  });

  it("settings picker refuses a model a selected environment lacks and writes nothing", async () => {
    const add = vi.spyOn(toastManager, "add");
    await render({
      kind: "new-thread-defaults",
      getModelDisabledReason: (_instanceId, model) =>
        model === "gpt-5.5" ? "Unavailable on Server." : null,
    });
    await openPicker();
    expect(row("GPT-5.5").getAttribute("aria-disabled")).toBe("true");

    await click(row("GPT-5.5"));

    expect(changes).toEqual([]);
    expect(add).not.toHaveBeenCalled();
  });

  it("settings picker shows Ultrathink without letting Settings choose it", async () => {
    await render({
      kind: "new-thread-defaults",
      selection: { instanceId: CLAUDE, model: "claude-opus-5" },
    });
    await openPicker();
    await press(searchInput(), "ArrowDown");
    await press(searchInput(), "ArrowRight");
    await press(searchInput(), "ArrowRight");
    expect(effortValue("Claude Opus 5")).toBe("High");
  });

  it("settings picker Escape discards the opening", async () => {
    await render({ kind: "new-thread-defaults", runtimeMode: "approval-required" });
    await openPicker();
    await press(searchInput(), "ArrowLeft");
    await click(moreOptionsToggle()!);
    await chooseOption("Access level", "auto");

    await press(document.activeElement ?? document.body, "Escape");

    expect(pickerContent()).toBeNull();
    expect(changes).toEqual([]);
  });
});

describe("combined picker in Settings: background writing", () => {
  it.each(["text-generation", "source-control-writing"] as const)(
    "settings picker %s shows access as task-managed and an unread option read-only",
    async (kind) => {
      await render({ kind });
      await openPicker();
      await click(moreOptionsToggle()!);

      expect(extrasRegion()?.textContent).toContain(SETTINGS_ACCESS_MANAGED_BY_TASK_LABEL);
      expect(extrasRegion()!.querySelector('[aria-label="Access level"]')).toBeNull();
      const contextWindow = extrasRegion()!.querySelector<HTMLSelectElement>(
        'select[aria-label="Context window"]',
      );
      expect(contextWindow?.disabled).toBe(true);
    },
  );

  it("settings picker writing settings write the model with its effort and no access", async () => {
    await render({ kind: "text-generation" });
    await openPicker();
    await press(searchInput(), "ArrowDown");
    await press(searchInput(), "ArrowLeft");

    await press(searchInput(), "Enter");

    expect(changes).toHaveLength(1);
    expect(changes[0]).not.toHaveProperty("runtimeMode");
    expect(changes[0]?.modelSelection).toMatchObject({ instanceId: CODEX, model: "gpt-5.4" });
    expect(changes[0]?.modelSelection?.options).toContainEqual({
      id: "reasoningEffort",
      value: "medium",
    });
  });
});
