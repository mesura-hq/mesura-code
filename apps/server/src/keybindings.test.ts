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
import { KeybindingsConfigError } from "@t3tools/contracts";

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
      assert.deepEqual(keysFor("thread.previous"), ["ctrl+shift+tab", "mod+shift+["]);
      assert.deepEqual(keysFor("thread.next"), ["ctrl+tab", "mod+shift+]"]);
      assert.equal(soleKeyFor("thread.jump.1"), "mod+1");
      assert.equal(soleKeyFor("thread.jump.9"), "mod+9");
      assert.deepEqual(keysFor("modelPicker.toggle"), ["alt+m", "mod+shift+m"]);
      assert.equal(soleKeyFor("themeEditor.toggle"), "mod+alt+shift+t");
      assert.equal(soleKeyFor("usage.peek"), "alt+u");
      assert.equal(soleKeyFor("filePicker.toggle"), "mod+p");
      assert.equal(soleKeyFor("projectSearch.toggle"), "mod+shift+f");
      assert.equal(soleKeyFor("sidebar.toggle"), "mod+b");
      assert.equal(soleKeyFor("rightPanel.toggle"), "mod+alt+b");
      assert.deepEqual(keysFor("rightPanel.toggleMaximized"), []);
      assert.equal(soleKeyFor("terminal.splitVertical"), "mod+shift+d");
      assert.equal(soleKeyFor("modelPicker.jump.1"), "mod+1");
      assert.equal(soleKeyFor("modelPicker.jump.9"), "mod+9");
      assert.equal(soleKeyFor("traitsPicker.toggle"), "alt+e");
      assert.equal(soleKeyFor("workspacePicker.toggle"), "alt+w");
      assert.equal(soleKeyFor("branchPicker.toggle"), "alt+b");
      assert.equal(soleKeyFor("chat.scrollHalfPageUp"), "mod+u");
      assert.equal(soleKeyFor("chat.scrollHalfPageDown"), "mod+d");
      // diff.toggle gave mod+d up to the reading scroll. terminal.splitVertical
      // also sits on mod+shift+d, but only while the terminal has focus, so the
      // two never resolve at the same time.
      assert.equal(soleKeyFor("diff.toggle"), "mod+shift+d");
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
        assert.isTrue(
          Keybindings.DEFAULT_KEYBINDINGS.some(
            (rule) => rule.command === entry.from.command && rule.key === entry.toKey,
          ),
          `retired default ${entry.from.command} moves to a key it no longer ships on`,
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

  it.effect("ships no two defaults on the same shortcut context", () =>
    Effect.sync(() => {
      // Resolution is last-wins, so two defaults sharing key and `when` would
      // silently make one command unreachable. mod+1 legitimately appears
      // twice under different `when` clauses, which this key separates.
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
      // Every default present, but diff.toggle still on its retired key. The
      // backfill has nothing to add, so only the rewrite justifies a write.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        ...Keybindings.DEFAULT_KEYBINDINGS.filter((rule) => rule.command !== "diff.toggle"),
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "diff.toggle").map((entry) => entry.key),
        ["mod+shift+d"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps a retired default when its new key is already taken", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // Moving onto mod+shift+d would put two commands on one chord and, since
      // resolution is last-wins, silently disable one of them.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
        { key: "mod+shift+d", command: "preview.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "diff.toggle").map((entry) => entry.key),
        ["mod+d"],
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.command === "preview.toggle" && entry.key === "mod+shift+d",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("rewrites when a same-command rule differs only by its when clause", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // An unrelated diff.toggle rule already sits on mod+shift+d but under a
      // different `when`, so the destination context is free.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
        { key: "mod+shift+d", command: "diff.toggle", when: "terminalOpen" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.command === "diff.toggle" &&
            entry.key === "mod+shift+d" &&
            entry.when === "!terminalFocus",
        ),
      );
      assert.isFalse(
        persisted.some((entry) => entry.key === "mod+d" && entry.command === "diff.toggle"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("collapses a retired default that appears twice into one rule", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "diff.toggle").map((entry) => entry.key),
        ["mod+shift+d"],
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
      }
    }),
  );

  it.effect("moves a retired default onto its current key and backfills what it freed", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      // The rule an install written before the diff.toggle move still carries.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "diff.toggle").map((entry) => entry.key),
        ["mod+shift+d"],
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
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "diff.toggle").map((entry) => entry.key),
        ["mod+shift+d"],
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

  it.effect("fails when config directory is not writable", () =>
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
