import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerModelSelection } from "./composerModelSelectionValidation";

const CODEX = ProviderInstanceId.make("codex");
const CODEX_TEAM = ProviderInstanceId.make("codex_team");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const OPENCODE = ProviderInstanceId.make("opencode");

function provider(input: {
  instanceId: ProviderInstanceId;
  driver: string;
  models: ReadonlyArray<{ slug: string; aliases?: ReadonlyArray<string> }>;
  continuationGroup?: string;
  requiresNewThreadForModelChange?: boolean;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T12:00:00.000Z",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: {},
      ...(model.aliases ? { aliases: [...model.aliases] } : {}),
    })),
    slashCommands: [],
    skills: [],
    ...(input.continuationGroup ? { continuation: { groupKey: input.continuationGroup } } : {}),
    ...(input.requiresNewThreadForModelChange ? { requiresNewThreadForModelChange: true } : {}),
  };
}

const PROVIDERS = [
  provider({
    instanceId: CODEX,
    driver: "codex",
    models: [{ slug: "gpt-5.4", aliases: ["gpt-5.4-latest"] }, { slug: "gpt-5.5" }],
  }),
  provider({ instanceId: CLAUDE, driver: "claudeAgent", models: [{ slug: "claude-opus-5" }] }),
];
const THREAD = {
  modelSelection: { instanceId: CODEX, model: "gpt-5.4" } satisfies ModelSelection,
  session: null,
};

function decide(overrides: Partial<Parameters<typeof resolveComposerModelSelection>[0]> = {}) {
  return resolveComposerModelSelection({
    instanceId: CODEX,
    model: "gpt-5.5",
    providers: PROVIDERS,
    settings: DEFAULT_UNIFIED_SETTINGS,
    lockedProvider: null,
    thread: THREAD,
    requireOfferedModel: true,
    savedModel: "gpt-5.4",
    ...overrides,
  });
}

describe("composer model selection validation", () => {
  it("composer model validation rejects a complete choice its exact instance does not offer", () => {
    expect(decide({ model: "review-absent-model" })).toEqual({ accepted: false, feedback: null });
  });

  it("composer model validation rejects an unknown instance", () => {
    expect(decide({ instanceId: ProviderInstanceId.make("review-absent-instance") })).toEqual({
      accepted: false,
      feedback: null,
    });
  });

  it("composer model validation normalizes an offered alias for a complete choice", () => {
    expect(decide({ model: "gpt-5.4-latest" })).toEqual({
      accepted: true,
      modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    });
  });

  it("guard: composer model validation keeps the default fallback for model-only changes", () => {
    expect(decide({ model: "review-absent-model", requireOfferedModel: false })).toEqual({
      accepted: true,
      modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    });
  });

  it("composer model validation keeps a locked thread on its driver", () => {
    expect(
      decide({
        instanceId: CLAUDE,
        model: "claude-opus-5",
        lockedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toEqual({ accepted: false, feedback: null });
  });

  it("composer model validation keeps a locked thread in its continuation group", () => {
    const providers = [
      provider({
        instanceId: CODEX,
        driver: "codex",
        models: [{ slug: "gpt-5.4" }],
        continuationGroup: "a",
      }),
      provider({
        instanceId: CODEX_TEAM,
        driver: "codex",
        models: [{ slug: "gpt-5.4" }],
        continuationGroup: "b",
      }),
    ];
    expect(
      decide({
        providers,
        instanceId: CODEX_TEAM,
        model: "gpt-5.4",
        lockedProvider: ProviderDriverKind.make("codex"),
        thread: { ...THREAD, session: { providerInstanceId: CODEX } },
      }),
    ).toEqual({ accepted: false, feedback: null });
  });

  it("composer model validation reports a started thread that cannot switch models", () => {
    const decision = decide({
      providers: [
        provider({
          instanceId: CODEX,
          driver: "codex",
          models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.5" }],
          requiresNewThreadForModelChange: true,
        }),
      ],
      thread: { ...THREAD, session: { providerInstanceId: CODEX } },
    });
    expect(decision.accepted).toBe(false);
    expect(decision.accepted ? null : decision.feedback?.title).toBe(
      "Start a new chat to change models",
    );
  });

  it("composer model validation re-applies only the saved model when OpenCode no longer lists it", () => {
    const providers = [
      provider({ instanceId: OPENCODE, driver: "opencode", models: [{ slug: "openrouter/live" }] }),
    ];
    const thread = {
      modelSelection: { instanceId: OPENCODE, model: "openrouter/gone" },
      session: null,
    };
    expect(
      decide({
        providers,
        thread,
        instanceId: OPENCODE,
        model: "openrouter/gone",
        savedModel: "openrouter/gone",
      }),
    ).toEqual({
      accepted: true,
      modelSelection: { instanceId: OPENCODE, model: "openrouter/gone" },
    });
    expect(
      decide({
        providers,
        thread,
        instanceId: OPENCODE,
        model: "openrouter/other-gone",
        savedModel: "openrouter/gone",
      }),
    ).toEqual({ accepted: false, feedback: null });
  });
});
