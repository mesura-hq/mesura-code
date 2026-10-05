import { KeybindingCommand, KeybindingRule, KeybindingsConfig } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
// The migration itself lives in the shared package; the server module wires
// it up but does not re-export it.
import {
  dropWithdrawnKeybindingDefaults,
  migrateRetiredKeybindingDefaults,
} from "@t3tools/shared/keybindings";
import { KeybindingsConfigError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);
const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(KeybindingsConfigJson);
const encodeResolvedKeybindingFromConfig = Schema.encodeEffect(
  Keybindings.ResolvedKeybindingFromConfig,
);
const decodeResolvedKeybindingFromConfigExit = Schema.decodeUnknownExit(
  Keybindings.ResolvedKeybindingFromConfig,
);
const makeKeybindingsLayer = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* decodeKeybindingsConfigJson(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(Keybindings.parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(Keybindings.parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = Keybindings.compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "terminal.split",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("encodes resolved plus-key shortcuts", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeResolvedKeybindingFromConfig({
        command: "terminal.toggle",
        shortcut: {
          key: "+",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      });

      assert.equal(encoded.key, "mod++");
      assert.equal(encoded.command, "terminal.toggle");
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("formats invalid resolved keybinding rules with the custom message", () =>
    Effect.sync(() => {
      const result = decodeResolvedKeybindingFromConfigExit({
        key: "mod+shift+d+o",
        command: "terminal.new",
      });

      if (result._tag !== "Failure") {
        assert.fail("Expected invalid keybinding decode to fail");
      }

      const detail = Cause.pretty(result.cause);
      assert.isTrue(detail.includes("Invalid keybinding rule"));
      assert.isFalse(detail.includes("Invalid data"));
    }),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, Keybindings.DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ships configurable thread navigation defaults", () =>
    Effect.sync(() => {
      // A command may ship more than one default, so collect every key rather
      // than letting the last entry win.
      const defaultsByCommand = new Map<string, string[]>();
      for (const binding of Keybindings.DEFAULT_KEYBINDINGS) {
        defaultsByCommand.set(binding.command, [
          ...(defaultsByCommand.get(binding.command) ?? []),
          binding.key,
        ]);
      }
      const keysFor = (command: string) => defaultsByCommand.get(command) ?? [];
      const soleKeyFor = (command: string) => {
        const keys = keysFor(command);
        assert.equal(keys.length, 1, `expected one default for ${command}, got ${keys.length}`);
        return keys[0];
      };

      // The everywhere-works chord is last on purpose: the label resolver
      // reports the binding that wins, and naming ctrl+tab would be wrong on
      // every surface that never receives it.
      //
      // The sidebar's bare letter is first for the same reason from the other
      // end. It only works with a thread row focused, so advertising `k` as
      // the way to reach the previous thread would be wrong everywhere else.
      assert.deepEqual(keysFor("thread.previous"), ["k", "ctrl+shift+tab", "mod+shift+["]);
      assert.deepEqual(keysFor("thread.next"), ["j", "ctrl+tab", "mod+shift+]"]);
      assert.deepEqual(keysFor("thread.nextPage"), ["mod+d"]);
      assert.deepEqual(keysFor("thread.previousPage"), ["mod+u"]);
      assert.equal(soleKeyFor("thread.jump.1"), "mod+1");
      assert.equal(soleKeyFor("thread.jump.9"), "mod+9");
      assert.deepEqual(keysFor("modelPicker.toggle"), ["alt+m", "mod+shift+m"]);
      assert.equal(soleKeyFor("themeEditor.toggle"), "mod+alt+shift+t");
      assert.equal(soleKeyFor("usage.peek"), "alt+u");
      assert.equal(soleKeyFor("hosts.peek"), "alt+s");
      assert.equal(soleKeyFor("filePicker.toggle"), "mod+p");
      assert.equal(soleKeyFor("projectSearch.toggle"), "mod+alt+g");
      assert.equal(soleKeyFor("projectScope.toggle"), "mod+shift+f");
      assert.equal(soleKeyFor("sidebar.toggle"), "mod+b");
      assert.equal(soleKeyFor("rightPanel.toggle"), "mod+alt+b");
      assert.deepEqual(keysFor("rightPanel.toggleMaximized"), []);
      assert.equal(soleKeyFor("terminal.splitVertical"), "mod+shift+d");
      assert.equal(soleKeyFor("modelPicker.jump.1"), "mod+1");
      assert.equal(soleKeyFor("modelPicker.jump.9"), "mod+9");
      assert.equal(soleKeyFor("traitsPicker.toggle"), "alt+e");
      assert.equal(soleKeyFor("workspacePicker.toggle"), "alt+w");
      assert.equal(soleKeyFor("branchPicker.toggle"), "alt+b");
      assert.equal(soleKeyFor("question.toggleCollapse"), "alt+q");
      // Upstream's thread.settle owns this chord since the 2026-W35 sync; the
      // fork's thread.toggleSettled does the same thing and is now unbound.
      // mod+s is composer.stash, so this sits one Shift away from it, and the
      // same-shortcut-context guard below proves the two stay apart.
      assert.equal(soleKeyFor("thread.settle"), "mod+shift+s");
      assert.equal(soleKeyFor("thread.pin"), "mod+shift+p");
      assert.equal(soleKeyFor("thread.copyReference"), "mod+shift+c");
      assert.equal(soleKeyFor("chat.scrollHalfPageUp"), "mod+u");
      assert.equal(soleKeyFor("chat.scrollHalfPageDown"), "mod+d");
      // Mesura: dictation.toggle took mod+shift+d from diff.toggle, which ships
      // unbound. terminal.splitVertical also sits on mod+shift+d, but only while
      // the terminal has focus, so the two never resolve at the same time.
      assert.equal(soleKeyFor("dictation.toggle"), "mod+shift+d");
      assert.deepEqual(keysFor("diff.toggle"), []);
    }),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        Keybindings.compileResolvedKeybindingsConfig(Keybindings.DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+t", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ]);

        yield* Effect.gen(function* () {
          const keybindings = yield* Keybindings.Keybindings;
          yield* keybindings.syncDefaultKeybindingsOnStartup;
        });

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+t");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        for (const defaultRule of Keybindings.DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));
      }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps every retired default entry consistent with the shipped defaults", () =>
    Effect.sync(() => {
      // A wrong entry here rewrites a real config on startup, so the table is
      // checked against the defaults rather than trusted.
      for (const entry of Keybindings.RETIRED_KEYBINDING_DEFAULTS) {
        assert.isNotNull(
          Keybindings.parseKeybindingShortcut(entry.toKey),
          `retired default ${entry.from.command} moves to an unparseable key`,
        );
        // Compared as a whole rule, `when` included: an entry that moves a
        // rule's context rather than its key would otherwise pass this by
        // matching the key it never left.
        assert.isTrue(
          Keybindings.DEFAULT_KEYBINDINGS.some((rule) =>
            Keybindings.isSameKeybindingRule(rule, {
              ...entry.from,
              key: entry.toKey,
              ...(entry.toWhen === undefined ? {} : { when: entry.toWhen }),
            }),
          ),
          `retired default ${entry.from.command} moves to a rule it no longer ships`,
        );
        assert.isFalse(
          Keybindings.DEFAULT_KEYBINDINGS.some((rule) =>
            Keybindings.isSameKeybindingRule(rule, entry.from),
          ),
          `retired default ${entry.from.command} is still a live default, so the rewrite would fight it every startup`,
        );
      }
    }),
  );

  it.effect("never withdraws a rule it still ships", () =>
    Effect.sync(() => {
      // A withdrawn rule that is also a live default would be removed from an
      // upgraded config while a fresh install still gets it.
      for (const { rule } of Keybindings.WITHDRAWN_KEYBINDING_DEFAULTS) {
        assert.isFalse(
          Keybindings.DEFAULT_KEYBINDINGS.some((entry) =>
            Keybindings.isSameKeybindingRule(entry, rule),
          ),
          `withdrawn default ${rule.command} is still a live default`,
        );
      }
    }),
  );

  it.effect("withdraws only an exact match, and records the offer either way", () =>
    Effect.sync(() => {
      const withdrawn = {
        key: "mod+shift+e",
        command: "composer.effort",
        when: "!terminalFocus",
      } as const;
      const other = { key: "mod+j", command: "terminal.toggle" } as const;
      const exact = dropWithdrawnKeybindingDefaults({
        config: [withdrawn, other],
        appliedIds: new Set(),
      });
      assert.deepEqual(exact.config, [other]);
      const effortOutcome = (results: typeof exact.results) =>
        results.find((entry) => entry.rule.command === "composer.effort")?.outcome;
      assert.equal(effortOutcome(exact.results), "dropped");

      // No `when` is a different rule, and so the user's own.
      const edited = { key: "mod+shift+e", command: "composer.effort" } as const;
      const kept = dropWithdrawnKeybindingDefaults({ config: [edited], appliedIds: new Set() });
      assert.deepEqual(kept.config, [edited]);
      assert.equal(effortOutcome(kept.results), "absent");

      const recorded = dropWithdrawnKeybindingDefaults({
        config: [withdrawn],
        appliedIds: new Set(kept.results.map((entry) => entry.id)),
      });
      assert.deepEqual(recorded.config, [withdrawn]);
      assert.deepEqual(recorded.results, []);
    }),
  );

  it.effect("ships no two defaults on the same shortcut context", () =>
    Effect.sync(() => {
      // Resolution is last-wins, so two defaults sharing key and `when` would
      // silently make one command unreachable. mod+1 legitimately appears
      // twice under different `when` clauses, which this key separates, and
      // so does mod+j once a pane chord shares it with the terminal toggle.
      const seen = new Set<string>();
      for (const rule of Keybindings.DEFAULT_KEYBINDINGS) {
        const context = `${rule.key}\u0000${rule.when ?? ""}`;
        assert.isFalse(seen.has(context), `two defaults share the context ${context}`);
        seen.add(context);
      }
    }),
  );

  it.effect("persists a rewrite even when there is nothing to backfill", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // Every default present, but threadSearch.toggle still on its retired
      // key. The backfill has nothing to add, so only the rewrite justifies a
      // write.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        ...Keybindings.DEFAULT_KEYBINDINGS.filter((rule) => rule.command !== "threadSearch.toggle"),
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted
          .filter((entry) => entry.command === "threadSearch.toggle")
          .map((entry) => entry.key),
        ["mod+alt+k"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("moves the content search off mod+shift+f and backfills the project scope picker", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // A config written before the chord moved: the content search still holds
      // mod+shift+f and projectScope.toggle does not appear in it at all. The
      // rewrite has to run before the backfill, or the backfill finds the chord
      // taken and silently skips the new command.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        ...Keybindings.DEFAULT_KEYBINDINGS.filter(
          (rule) =>
            rule.command !== "projectSearch.toggle" && rule.command !== "projectScope.toggle",
        ),
        { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted
          .filter((entry) => entry.command === "projectSearch.toggle")
          .map((entry) => entry.key),
        ["mod+alt+g"],
      );
      assert.deepEqual(
        persisted
          .filter((entry) => entry.command === "projectScope.toggle")
          .map((entry) => entry.key),
        ["mod+shift+f"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("installs the hosts peek on alt+s in a config written before it existed", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // A config from before the Hosts dock: every other default, and no
      // hosts.peek at all. The per-command startup backfill has to add it.
      yield* writeKeybindingsConfig(
        keybindingsConfigPath,
        Keybindings.DEFAULT_KEYBINDINGS.filter((rule) => rule.command !== "hosts.peek"),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "hosts.peek").map((entry) => entry.key),
        ["alt+s"],
      );
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "usage.peek").map((entry) => entry.key),
        ["alt+u"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("leaves an already-migrated config untouched on the next startup", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        ...Keybindings.DEFAULT_KEYBINDINGS.filter(
          (rule) =>
            rule.command !== "projectSearch.toggle" && rule.command !== "projectScope.toggle",
        ),
        { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
      ]);

      const sync = Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      yield* sync;
      const afterFirstStartup = yield* readKeybindingsConfig(keybindingsConfigPath);
      yield* sync;
      const afterSecondStartup = yield* readKeybindingsConfig(keybindingsConfigPath);

      // A retirement that re-fired would move the rule a second time, and a
      // backfill that forgot its ledger would append the same rule twice. Both
      // failures look like a working migration until someone boots twice.
      assert.deepEqual(afterSecondStartup, afterFirstStartup);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps a retired default when its new key is already taken", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // Moving onto mod+alt+k would put two commands on one chord and, since
      // resolution is last-wins, silently disable one of them.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
        { key: "mod+alt+k", command: "preview.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted
          .filter((entry) => entry.command === "threadSearch.toggle")
          .map((entry) => entry.key),
        ["mod+shift+k"],
      );
      assert.isTrue(
        persisted.some((entry) => entry.command === "preview.toggle" && entry.key === "mod+alt+k"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("rewrites when a same-command rule differs only by its when clause", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // An unrelated threadSearch.toggle rule already sits on mod+alt+k but
      // under a different `when`, so the destination context is free.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
        { key: "mod+alt+k", command: "threadSearch.toggle", when: "terminalOpen" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.command === "threadSearch.toggle" &&
            entry.key === "mod+alt+k" &&
            entry.when === "!terminalFocus",
        ),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.key === "mod+shift+k" && entry.command === "threadSearch.toggle",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("collapses a retired default that appears twice into one rule", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted
          .filter((entry) => entry.command === "threadSearch.toggle")
          .map((entry) => entry.key),
        ["mod+alt+k"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("adds a default introduced for a command the config already binds", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // Per-command backfill would skip alt+m entirely: modelPicker.toggle is
      // already here, so the second default would never reach this install.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some((entry) => entry.command === "modelPicker.toggle" && entry.key === "alt+m"),
      );
      assert.isTrue(
        persisted.some((entry) => entry.command === "thread.next" && entry.key === "ctrl+tab"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("offers an introduced default once, so deleting it makes it stay deleted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      // The user removes the shortcut that was just offered.
      const afterFirstRun = yield* readKeybindingsConfig(keybindingsConfigPath);
      yield* writeKeybindingsConfig(
        keybindingsConfigPath,
        afterFirstRun.filter((entry) => entry.key !== "alt+m"),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(
        persisted.some((entry) => entry.key === "alt+m"),
        "an introduced default came back after the user deleted it",
      );
      assert.isTrue(
        yield* fs.exists(`${keybindingsConfigPath.replace(/\.json$/, "")}.applied.json`),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("never lets an introduced default take a key the user already bound", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
        { key: "alt+m", command: "preview.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.key === "alt+m").map((entry) => entry.command),
        ["preview.toggle"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("does not let an addition suppress that command's other defaults", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // thread.next is unbound here, so the ordinary per-command backfill owes
      // this config every thread.next default, not just the introduced one.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+b", command: "sidebar.toggle" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "thread.next").map((entry) => entry.key),
        ["j", "ctrl+tab", "mod+shift+]"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("stays within the entry cap instead of failing the write", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // A config already at the cap. Appending an addition would push the
      // encode past its max-length check and fail startup outright.
      const filler = Array.from({ length: 255 }, (_unused, index) => ({
        key: `mod+alt+shift+f${index}`,
        command: "sidebar.toggle" as const,
      }));
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
        ...filler,
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isAtMost(persisted.length, 256);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps a deleted shortcut deleted when the ledger cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath, keybindingsAppliedPath } = yield* ServerConfig.ServerConfig;
      // The user was offered alt+m, removed it, and the ledger later got
      // corrupted. Reading it as empty would undo their deletion.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
      ]);
      yield* fs.writeFileString(keybindingsAppliedPath, "{ not-json");

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.key === "alt+m"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("seeds the ledger on a fresh install so nothing is re-offered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath, keybindingsAppliedPath } = yield* ServerConfig.ServerConfig;

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const ledger = yield* fs.readFileString(keybindingsAppliedPath);
      for (const addition of Keybindings.ADDED_KEYBINDING_DEFAULTS) {
        assert.isTrue(ledger.includes(addition.id), `ledger is missing ${addition.id}`);
      }

      // A user removing one of them on a fresh install must also make it stay
      // removed, which only holds because the ledger was seeded above.
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      yield* writeKeybindingsConfig(
        keybindingsConfigPath,
        persisted.filter((entry) => entry.key !== "alt+m"),
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const afterDelete = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(afterDelete.some((entry) => entry.key === "alt+m"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps every introduced default consistent with the shipped defaults", () =>
    Effect.sync(() => {
      const seenIds = new Set<string>();
      for (const addition of Keybindings.ADDED_KEYBINDING_DEFAULTS) {
        assert.isFalse(seenIds.has(addition.id), `duplicate addition id ${addition.id}`);
        seenIds.add(addition.id);
        // An addition that is not a shipped default would hand out a binding
        // a fresh install never gets, so the two would drift apart.
        assert.isTrue(
          Keybindings.DEFAULT_KEYBINDINGS.some((rule) =>
            Keybindings.isSameKeybindingRule(rule, addition.rule),
          ),
          `introduced default ${addition.id} is not in DEFAULT_KEYBINDINGS`,
        );
        if (!addition.insertBefore) continue;
        const additionIndex = Keybindings.DEFAULT_KEYBINDINGS.findIndex((rule) =>
          Keybindings.isSameKeybindingRule(rule, addition.rule),
        );
        const beforeIndex = Keybindings.DEFAULT_KEYBINDINGS.findIndex((rule) =>
          Keybindings.isSameKeybindingRule(rule, addition.insertBefore!),
        );
        assert.isAtLeast(beforeIndex, 0, `insertBefore of ${addition.id} is not a shipped default`);
        assert.isBelow(
          additionIndex,
          beforeIndex,
          `${addition.id} must precede its insertBefore in DEFAULT_KEYBINDINGS too, or a fresh install and an upgraded one would advertise different chords`,
        );
      }
    }),
  );

  it.effect("withdraws diff.toggle and gives its chord to dictation in one startup", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // An install from before dictation.toggle had a default: every other
      // default, with diff.toggle on mod+shift+d. The withdrawal has to run
      // before the backfill, or the backfill sees the chord taken and skips.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        ...Keybindings.DEFAULT_KEYBINDINGS.filter((rule) => rule.command !== "dictation.toggle"),
        { key: "mod+shift+d", command: "diff.toggle", when: "!terminalFocus" },
      ]);

      const sync = Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });
      yield* sync;

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "diff.toggle"));
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "dictation.toggle"),
        [{ key: "mod+shift+d", command: "dictation.toggle", when: "!terminalFocus" }],
      );

      // Once: a user who binds diff.toggle there again keeps it.
      const rebound = { key: "mod+alt+d", command: "diff.toggle", when: "!terminalFocus" } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [...persisted, rebound]);
      yield* sync;
      const afterSecondStartup = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        afterSecondStartup.some((entry) => Keybindings.isSameKeybindingRule(entry, rebound)),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("withdraws diff.toggle's older mod+d rule and backfills what it freed", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // The rule an install written before diff.toggle first moved still
      // carries. Rewriting it onto mod+shift+d now would block dictation.toggle.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "diff.toggle"));
      assert.isTrue(
        persisted.some(
          (entry) => entry.command === "dictation.toggle" && entry.key === "mod+shift+d",
        ),
      );
      // Freeing mod+d is the whole point. Without the rewrite the scroll
      // default reads as conflicting and is skipped, so half the shipped pair
      // ends up with no binding at all and nothing says so.
      assert.isTrue(
        persisted.some(
          (entry) => entry.command === "chat.scrollHalfPageDown" && entry.key === "mod+d",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ships the half-page scroll pair scoped to the chat pane", () =>
    Effect.sync(() => {
      // The pair used to fire wherever the terminal did not have focus, which
      // included the editor, where those keys belong to Neovim.
      for (const command of ["chat.scrollHalfPageUp", "chat.scrollHalfPageDown"] as const) {
        const rules = Keybindings.DEFAULT_KEYBINDINGS.filter((rule) => rule.command === command);
        assert.deepEqual(
          rules.map((rule) => rule.when),
          ["chatFocus"],
          `${command} must belong to the chat pane and nothing else`,
        );
      }
    }),
  );

  it.effect("moves a retired default to a new context on the key it already had", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // The rule an install written before the pane model still carries.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+u", command: "chat.scrollHalfPageUp", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "chat.scrollHalfPageUp"),
        [{ key: "mod+u", command: "chat.scrollHalfPageUp", when: "chatFocus" }],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports a context move on the rewrite, so the startup log can say so", () =>
    Effect.sync(() => {
      // A context move keeps its key, so fromKey and toKey are equal and the
      // log line would otherwise read as a no-op.
      const contextMove = migrateRetiredKeybindingDefaults([
        { key: "mod+u", command: "chat.scrollHalfPageUp", when: "!terminalFocus" },
      ]);
      assert.deepEqual(contextMove.rewrites, [
        {
          command: "chat.scrollHalfPageUp",
          fromKey: "mod+u",
          toKey: "mod+u",
          toWhen: "chatFocus",
        },
      ]);

      // A plain key move carries no context, so the field stays absent.
      const keyMove = migrateRetiredKeybindingDefaults([
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
      ]);
      assert.deepEqual(keyMove.rewrites, [
        { command: "threadSearch.toggle", fromKey: "mod+shift+k", toKey: "mod+alt+k" },
      ]);
    }),
  );

  it.effect("gives mod+shift+e back to the file manager in one startup", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // An install from v0.0.42 until now: the effort picker holds
      // mod+shift+e and the file manager sits on mod+alt+e. The drop has to
      // run first, or the move sees mod+shift+e as taken and stays blocked.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
        { key: "mod+alt+e", command: "fileTree.miller", when: "!terminalFocus" },
        { key: "alt+e", command: "traitsPicker.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      // Both chords, mod+shift+e last so it is the label, as on a fresh install.
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "fileTree.miller"),
        [
          { key: "mod+alt+e", command: "fileTree.miller", when: "!terminalFocus" },
          { key: "mod+shift+e", command: "fileTree.miller", when: "!terminalFocus" },
        ],
      );
      // Not backfilled either: the command no longer ships a default.
      assert.isFalse(persisted.some((entry) => entry.command === "composer.effort"));
      // The picker stays reachable from the keyboard.
      assert.isTrue(
        persisted.some((entry) => entry.command === "traitsPicker.toggle" && entry.key === "alt+e"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("drops and adds once, so a later choice of the user's stands", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const sync = Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
        { key: "mod+alt+e", command: "fileTree.miller", when: "!terminalFocus" },
      ]);
      yield* sync;

      // The user takes mod+shift+e back for the effort picker, the exact rule
      // that was withdrawn, and so gives the file manager's copy up.
      const afterFirst = yield* readKeybindingsConfig(keybindingsConfigPath);
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        ...afterFirst.filter(
          (entry) => !(entry.command === "fileTree.miller" && entry.key === "mod+shift+e"),
        ),
        { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
      ]);
      yield* sync;

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.key === "mod+shift+e"),
        [{ key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" }],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps an effort binding the user chose", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+alt+r", command: "composer.effort", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "composer.effort"),
        [{ key: "mod+alt+r", command: "composer.effort", when: "!terminalFocus" }],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("moves the palette onto the key the favourite editor vacates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // An install from before the pane chords: the palette still holds
      // mod+k and the favourite editor still holds mod+o, which is where the
      // palette has to land.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
        { key: "mod+o", command: "editor.openFavorite" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "commandPalette.toggle"),
        [{ key: "mod+o", command: "commandPalette.toggle", when: "!terminalFocus" }],
      );
      // alt+o rather than mod+shift+o: that key already carries a second
      // chat.new default, which an unconditional rule there would shadow.
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "editor.openFavorite"),
        [{ key: "alt+o", command: "editor.openFavorite" }],
      );
      // Freeing mod+k is the whole point: pane.focusUp has to be able to
      // take it in the same startup.
      assert.isTrue(
        persisted.some((entry) => entry.command === "pane.focusUp" && entry.key === "mod+k"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps the two mod+j defaults in the one order that works", () =>
    Effect.sync(() => {
      // Both the context and the order were got wrong once, in opposite
      // directions, so both are asserted here.
      //
      // Separate contexts, or backfill skips the pane rule and it never
      // reaches an existing config. Pane rule first, or last-wins answers it
      // instead of the toggle and ChatView, which has no branch for a pane
      // command, drops the key: the drawer never opens.
      const onModJ = Keybindings.DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "mod+j");
      assert.deepEqual(onModJ, [
        { key: "mod+j", command: "pane.focusDown", when: "chatFocus" },
        { key: "mod+j", command: "terminal.toggle" },
      ]);
    }),
  );

  it.effect("ships no default that another default shadows outright", () =>
    Effect.sync(() => {
      // Resolution is last-wins, so a rule with no `when` makes every earlier
      // rule on its key unreachable, whatever their clauses say. That is
      // invisible to the same-context check above, and it is how
      // editor.openFavorite silently took mod+shift+o away from chat.new.
      //
      // One pair is exempt, named as a pair rather than by a `pane.` prefix:
      // a prefix would wave through the next pane command shadowed by
      // accident, which is the very class of bug this guard exists to catch.
      // `pane.focusDown` sits behind `terminal.toggle` on mod+j on purpose:
      // it is dispatched by usePaneNavigation, which matches it directly, so
      // being unreachable by resolution is its design rather than a defect.
      const INTENTIONALLY_SHADOWED = [{ key: "mod+j", command: "pane.focusDown" }];

      const byKey = new Map<string, Array<{ command: string; when?: string }>>();
      for (const rule of Keybindings.DEFAULT_KEYBINDINGS) {
        const rules = byKey.get(rule.key) ?? [];
        rules.push({
          command: rule.command,
          ...(rule.when === undefined ? {} : { when: rule.when }),
        });
        byKey.set(rule.key, rules);
      }

      const shadowed: string[] = [];
      for (const [key, rules] of byKey) {
        for (let earlier = 0; earlier < rules.length; earlier += 1) {
          const victim = rules[earlier];
          if (victim === undefined || victim.when === undefined) continue;
          if (
            INTENTIONALLY_SHADOWED.some(
              (allowed) => allowed.key === key && allowed.command === victim.command,
            )
          ) {
            continue;
          }
          for (let later = earlier + 1; later < rules.length; later += 1) {
            if (rules[later]?.when === undefined) {
              shadowed.push(`${key}: ${victim.command} is shadowed by ${rules[later]?.command}`);
            }
          }
        }
      }
      assert.deepEqual(shadowed, []);
    }),
  );

  it.effect("leaves a scroll rule whose context the user already changed alone", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // Same key and command as the retired default, different `when`, so it
      // is the user's own rule.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+u", command: "chat.scrollHalfPageUp", when: "terminalOpen" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "chat.scrollHalfPageUp"),
        [{ key: "mod+u", command: "chat.scrollHalfPageUp", when: "terminalOpen" }],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("leaves a rule that only partly matches a retired default alone", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // Same key and command as the retired default but a different `when`,
      // so it is the user's own rule and must not be rewritten.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+d", command: "diff.toggle", when: "terminalOpen" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "diff.toggle"),
        [{ key: "mod+d", command: "diff.toggle", when: "terminalOpen" }],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("rewrites a retired default only once", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+k", command: "threadSearch.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted
          .filter((entry) => entry.command === "threadSearch.toggle")
          .map((entry) => entry.key),
        ["mod+alt+k"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeKeybindingsLayer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("upserts custom keybindings to configured path", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));

      assert.deepEqual(persistedView, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      assert.isTrue(resolved.some((entry) => entry.command === "script.run-tests.run"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("appends additional custom keybindings for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replacing with a rule that already exists elsewhere does not duplicate it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("removes only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.removeKeybindingRule({
          key: "mod+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports non-array config parse errors without duplicate prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        '{"key":"mod+j","command":"terminal.toggle"}',
      );

      const firstResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(firstResult, "expected JSON array");

      const secondResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(secondResult, "expected JSON array");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  // chmod cannot make a directory unwritable on Windows, so the write succeeds.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "fails when config directory is not writable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const { dirname } = yield* Path.Path;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+j", command: "terminal.toggle" },
        ]);
        yield* fs.chmod(dirname(keybindingsConfigPath), 0o500);

        const result = yield* Effect.gen(function* () {
          const keybindings = yield* Keybindings.Keybindings;
          return yield* keybindings.upsertKeybindingRule({
            key: "mod+shift+r",
            command: "script.run-tests.run",
          });
        }).pipe(toDetailResult);
        assertFailure(result, "failed to write keybindings config");

        yield* fs.chmod(dirname(keybindingsConfigPath), 0o700);

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const persistedView = persisted.map(({ key, command }) => ({ key, command }));
        assert.deepEqual(persistedView, [{ key: "mod+j", command: "terminal.toggle" }]);
      }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("caches loaded resolved config across repeated reads", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        const firstLoad = (yield* keybindings.loadConfigState).keybindings;
        const secondLoad = (yield* keybindings.loadConfigState).keybindings;
        return [firstLoad, secondLoad] as const;
      });

      assert.deepEqual(first, second);
      assert.isTrue(second.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("updates cached resolved config after upsert", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const loadedAfterUpsert = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.loadConfigState;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
        return (yield* keybindings.loadConfigState).keybindings;
      });

      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "script.run-tests.run"));
      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* Effect.all(
          commands.map((command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          ),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
});

it("binds threadSearch.toggle to mod+alt+k outside terminal focus", () => {
  const rules = Keybindings.DEFAULT_KEYBINDINGS.filter(
    (rule) => rule.command === "threadSearch.toggle",
  );
  assert.strictEqual(rules.length, 1, "expected exactly one default for threadSearch.toggle");
  assert.strictEqual(rules[0]?.key, "mod+alt+k");
  assert.strictEqual(rules[0]?.when, "!terminalFocus");
});

it("gives the thread search a chord no other default claims in the same context", () => {
  const clashes = Keybindings.DEFAULT_KEYBINDINGS.filter(
    (rule) =>
      rule.key === "mod+alt+k" &&
      rule.command !== "threadSearch.toggle" &&
      rule.when === "!terminalFocus",
  );
  assert.deepEqual(clashes, []);
});

// This used to assert the opposite: threadSearch.toggle shipped on a free chord,
// so the per-command startup backfill installed it and no retirement was needed.
// v0.0.42 gave mod+shift+k to pullRequest.copyNumber, so the chord moved and an
// installed config now needs the rewrite to follow it. Do not restore the
// no-entry assertion without moving the default back to a chord upstream leaves
// alone.
it("retires threadSearch.toggle off the chord v0.0.42 claimed", () => {
  assert.deepEqual(
    Keybindings.RETIRED_KEYBINDING_DEFAULTS.filter(
      (entry) => entry.from.command === "threadSearch.toggle",
    ).map((entry) => [entry.from.key, entry.toKey]),
    [["mod+shift+k", "mod+alt+k"]],
  );
  // Still no ADDED entry: that mechanism is for a SECOND default on a command a
  // config already binds, and this command has exactly one.
  assert.deepEqual(
    Keybindings.ADDED_KEYBINDING_DEFAULTS.filter(
      (entry) => entry.rule.command === "threadSearch.toggle",
    ),
    [],
  );
});
