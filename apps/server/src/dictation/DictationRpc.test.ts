/**
 * Phase 1 fence of the dictation redesign: acceptance criteria 6 (the key in
 * the secret store, redacted for clients) and 8 (RPC scopes), plus the guard
 * on the usage-limit `managementKey` pattern this phase copies.
 *
 * Entry points:
 * - `ServerSettings.layer` over the real secret store, written through
 *   `updateSettings` as the `server.updateSettings` handler does, and
 *   `redactServerSettingsForClient`, which every settings payload in `ws.ts`
 *   passes through before it reaches a client (the get, update and stream
 *   handlers, and the config snapshot).
 * - `WsRpcGroup` and `requiredScopeForRpcMethod`, which the RPC layer
 *   enforces on every request.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ServerSettings,
  UsageLimitSourceId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const makeSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "dictation-rpc-settings-" })),
    ),
  );

/** Reads the settings back through a fresh service over the same files and secret store. */
const reloadSettings = Effect.gen(function* () {
  const fresh = yield* ServerSettingsModule.ServerSettingsService;
  return yield* fresh.getSettings;
}).pipe(
  Effect.provide(
    Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
  ),
);

/** The JSON text the RPC serializer sends for a settings payload. */
const toClientJson = Schema.encodeSync(Schema.fromJsonString(ServerSettings));

const HUB_ID = UsageLimitSourceId.make("dictation-guard-hub");
const HUB_KEY = "management-key-guard-secret";
const OPENAI_KEY = "sk-dictation-ac6-secret";

/** The marker the usage-limit redaction already sends; dictation reuses it. */
const usageLimitRedactionMarker = Effect.gen(function* () {
  const service = yield* ServerSettingsModule.ServerSettingsService;
  const settings = yield* service.getSettings;
  return ServerSettingsModule.redactServerSettingsForClient({
    ...settings,
    usageLimitSources: {
      [HUB_ID]: {
        kind: "cliproxy",
        url: "http://hub.test:8317",
        managementKey: "x",
        enabled: true,
      },
    },
  }).usageLimitSources[HUB_ID]!.managementKey;
});

it.layer(NodeServices.layer)("DictationRpc phase 1 fence: settings", (it) => {
  it.effect(
    "dictation phase 1 guard: the usage-limit managementKey lives in the secret store and reaches clients as the marker",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;

        yield* service.updateSettings({
          usageLimitSources: {
            [HUB_ID]: {
              kind: "cliproxy",
              url: "http://hub.test:8317",
              managementKey: HUB_KEY,
              enabled: true,
            },
          },
        });

        assert.notInclude(yield* fs.readFileString(config.settingsPath), HUB_KEY);
        const settings = yield* service.getSettings;
        assert.strictEqual(settings.usageLimitSources[HUB_ID]?.managementKey, HUB_KEY);
        assert.strictEqual(
          (yield* reloadSettings).usageLimitSources[HUB_ID]?.managementKey,
          HUB_KEY,
        );

        const redacted = ServerSettingsModule.redactServerSettingsForClient(settings);
        const marker = redacted.usageLimitSources[HUB_ID]?.managementKey;
        assert.strictEqual(marker, "•".repeat(6));
        assert.notInclude(toClientJson(redacted), HUB_KEY);

        // Sending the marker back keeps the stored key.
        yield* service.updateSettings({
          usageLimitSources: {
            [HUB_ID]: {
              kind: "cliproxy",
              url: "http://hub.test:8317",
              managementKey: marker!,
              enabled: true,
            },
          },
        });
        assert.strictEqual(
          (yield* service.getSettings).usageLimitSources[HUB_ID]?.managementKey,
          HUB_KEY,
        );
      }).pipe(Effect.provide(makeSettingsLayer())),
  );

  it.effect(
    "dictation phase 1 AC6: the OpenAI key is kept in the secret store and every client payload carries only the marker",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const marker = yield* usageLimitRedactionMarker;

        const updated = yield* service.updateSettings({
          dictation: { openAiApiKey: OPENAI_KEY, vocabularyHints: ["Mesura", "Hyprland"] },
        });

        // Never in settings.json; the server itself still reads the real key.
        assert.notInclude(yield* fs.readFileString(config.settingsPath), OPENAI_KEY);
        const settings = yield* service.getSettings;
        assert.strictEqual(settings.dictation.openAiApiKey, OPENAI_KEY);
        assert.deepStrictEqual(settings.dictation.vocabularyHints, ["Mesura", "Hyprland"]);
        assert.strictEqual((yield* reloadSettings).dictation.openAiApiKey, OPENAI_KEY);

        // What the get, update and stream handlers send.
        for (const payload of [settings, updated]) {
          const redacted = ServerSettingsModule.redactServerSettingsForClient(payload);
          assert.strictEqual(redacted.dictation.openAiApiKey, marker);
          assert.deepStrictEqual(redacted.dictation.vocabularyHints, ["Mesura", "Hyprland"]);
          assert.notInclude(toClientJson(redacted), OPENAI_KEY);
        }
      }).pipe(Effect.provide(makeSettingsLayer())),
  );

  it.effect(
    "dictation phase 1 AC6: a client that sends the marker back keeps the stored OpenAI key, and an empty key clears it",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const marker = yield* usageLimitRedactionMarker;
        yield* service.updateSettings({ dictation: { openAiApiKey: OPENAI_KEY } });

        yield* service.updateSettings({
          dictation: { openAiApiKey: marker, vocabularyHints: ["Neovim"] },
        });
        const kept = yield* service.getSettings;
        assert.strictEqual(kept.dictation.openAiApiKey, OPENAI_KEY);
        assert.deepStrictEqual(kept.dictation.vocabularyHints, ["Neovim"]);

        yield* service.updateSettings({ dictation: { openAiApiKey: "" } });
        const cleared = yield* service.getSettings;
        assert.strictEqual(cleared.dictation.openAiApiKey, "");
        assert.strictEqual((yield* reloadSettings).dictation.openAiApiKey, "");
        // No key: the client sees no marker, so it can tell the key is missing.
        assert.strictEqual(
          ServerSettingsModule.redactServerSettingsForClient(cleared).dictation.openAiApiKey,
          "",
        );
      }).pipe(Effect.provide(makeSettingsLayer())),
  );
});

describe("DictationRpc phase 1 fence: RPC scopes", () => {
  const operateMethods = [
    WS_METHODS.dictationStart,
    WS_METHODS.dictationRetry,
    WS_METHODS.dictationCancel,
    WS_METHODS.dictationSetMode,
  ];

  it("dictation phase 1 AC8: every dictation RPC is registered in the WebSocket RPC group", () => {
    const registered = new Set(WsRpcGroup.requests.keys());
    for (const method of [...operateMethods, WS_METHODS.subscribeDictationJobs]) {
      assert.isTrue(registered.has(method), `${method} is in WsRpcGroup`);
    }
  });

  it("dictation phase 1 AC8: start, retry, cancel and setMode require the operate scope", () => {
    for (const method of operateMethods) {
      assert.strictEqual(requiredScopeForRpcMethod(method), AuthOrchestrationOperateScope, method);
    }
  });

  it("dictation phase 1 AC8: subscribeDictationJobs requires the read scope", () => {
    assert.strictEqual(
      requiredScopeForRpcMethod(WS_METHODS.subscribeDictationJobs),
      AuthOrchestrationReadScope,
    );
  });
});
