/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingsConfigError,
  KeybindingShortcut,
  KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
  type ServerConfigIssue,
} from "@t3tools/contracts";
import * as Array from "effect/Array";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Ref from "effect/Ref";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "./config.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  ADDED_KEYBINDING_DEFAULTS,
  RETIRED_KEYBINDING_DEFAULTS,
  addIntroducedKeybindingDefaults,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  isSameKeybindingRule,
  migrateRetiredKeybindingDefaults,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";
import { withCurrentKeybindingCommand } from "@t3tools/shared/renamedKeybindingCommands";

export {
  ADDED_KEYBINDING_DEFAULTS,
  DEFAULT_KEYBINDINGS,
  RETIRED_KEYBINDING_DEFAULTS,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  isSameKeybindingRule,
  parseKeybindingShortcut,
};

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue({
                message: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue({
                message: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

export const ResolvedKeybindingsFromConfig = Schema.Array(ResolvedKeybindingFromConfig).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  if (!parsed) return null;
  const encoded = encodeShortcut(parsed);
  if (!encoded) return null;
  return `${encoded}\u0000${rule.when ?? ""}`;
}

function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

function keybindingRuleFromUpsertInput(input: ServerUpsertKeybindingInput): KeybindingRule {
  return input.when === undefined
    ? { key: input.key, command: input.command }
    : { key: input.key, command: input.command, when: input.when };
}

function replaceTargetFromUpsertInput(input: ServerUpsertKeybindingInput): KeybindingRule | null {
  if (!input.replace) return null;
  return input.replace.when === undefined
    ? { key: input.replace.key, command: input.replace.command }
    : { key: input.replace.key, command: input.replace.command, when: input.replace.when };
}

function keybindingRuleFromRemoveInput(input: ServerRemoveKeybindingInput): KeybindingRule {
  return input.when === undefined
    ? { key: input.key, command: input.command }
    : { key: input.key, command: input.command, when: input.when };
}

function encodeShortcut(shortcut: KeybindingShortcut): string | null {
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  if (!shortcut.key) return null;
  if (shortcut.key !== "+" && shortcut.key.includes("+")) return null;
  const key = shortcut.key === " " ? "space" : shortcut.key;
  return [...modifiers, key].join("+");
}

function encodeWhenAst(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${encodeWhenAst(node.node)})`;
    case "and":
      return `(${encodeWhenAst(node.left)} && ${encodeWhenAst(node.right)})`;
    case "or":
      return `(${encodeWhenAst(node.left)} || ${encodeWhenAst(node.right)})`;
  }
}

const RawKeybindingsEntries = fromLenientJson(Schema.Array(Schema.Unknown));
const AppliedAdditionIdsJson = fromJsonStringPretty(Schema.Array(Schema.String));
const decodeAppliedAdditionIdsExit = Schema.decodeUnknownExit(AppliedAdditionIdsJson);
const encodeAppliedAdditionIdsJson = Schema.encodeEffect(AppliedAdditionIdsJson);
const KeybindingsConfigPrettyJson = fromJsonStringPretty(KeybindingsConfig);
const decodeKeybindingRuleExit = Schema.decodeUnknownExit(KeybindingRule);
const decodeResolvedKeybindingFromConfigExit = Schema.decodeExit(ResolvedKeybindingFromConfig);
const decodeRawKeybindingsEntriesExit = Schema.decodeUnknownExit(RawKeybindingsEntries);
const encodeKeybindingsConfigPrettyJson = Schema.encodeEffect(KeybindingsConfigPrettyJson);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends Context.Service<
  Keybindings,
  {
    /**
     * Start the keybindings runtime and attach file watching.
     *
     * Safe to call multiple times. The first successful call establishes the
     * runtime; later calls await the same startup.
     */
    readonly start: Effect.Effect<void, KeybindingsConfigError>;

    /**
     * Await keybindings runtime readiness.
     *
     * Readiness means the config directory exists, the watcher is attached, the
     * startup sync has completed, and the current snapshot has been loaded.
     */
    readonly ready: Effect.Effect<void, KeybindingsConfigError>;

    /**
     * Ensure the on-disk keybindings file exists and includes all default
     * commands so newly-added defaults are backfilled on startup.
     */
    readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

    /**
     * Load runtime keybindings state along with non-fatal configuration issues.
     */
    readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    /**
     * Read the latest keybindings snapshot from cache/disk.
     */
    readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

    /**
     * Stream of keybindings config change events.
     */
    readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

    /**
     * Upsert a keybinding rule and persist the resulting configuration.
     *
     * Writes config atomically and enforces the max rule count by truncating
     * oldest entries when needed.
     */
    readonly upsertKeybindingRule: (
      input: ServerUpsertKeybindingInput,
    ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;

    /**
     * Remove a single persisted keybinding rule by exact key/command/when match.
     */
    readonly removeKeybindingRule: (
      input: ServerRemoveKeybindingInput,
    ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;
  }
>()("t3/keybindings") {}

const make = Effect.gen(function* () {
  const { keybindingsConfigPath, keybindingsAppliedPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );

  const loadWritableCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    readonly KeybindingRule[],
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return [];
    }

    const rawConfig = yield* readRawConfig.pipe(
      Effect.flatMap(Schema.decodeEffect(RawKeybindingsEntries)),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "expected JSON array",
            cause,
          }),
      ),
    );

    return yield* Effect.forEach(rawConfig, (entry) =>
      Effect.gen(function* () {
        const decodedRule = decodeKeybindingRuleExit(withCurrentKeybindingCommand(entry));
        if (decodedRule._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            entry,
            error: Cause.pretty(decodedRule.cause),
          });
          return null;
        }
        const resolved = decodeResolvedKeybindingFromConfigExit(decodedRule.value);
        if (resolved._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: keybindingsConfigPath,
            entry,
            error: Cause.pretty(resolved.cause),
          });
          return null;
        }
        return decodedRule.value;
      }),
    ).pipe(Effect.map(Array.filter(Predicate.isNotNull)));
  });

  const loadRuntimeCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    {
      readonly keybindings: readonly KeybindingRule[];
      readonly issues: readonly ServerConfigIssue[];
    },
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { keybindings: [], issues: [] };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = decodeRawKeybindingsEntriesExit(rawConfig);
    if (decodedEntries._tag === "Failure") {
      const detail = `expected JSON array (${Cause.pretty(decodedEntries.cause)})`;
      return {
        keybindings: [],
        issues: [malformedConfigIssue(detail)],
      };
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of decodedEntries.value.entries()) {
      const decodedRule = decodeKeybindingRuleExit(withCurrentKeybindingCommand(entry));
      if (decodedRule._tag === "Failure") {
        const detail = Cause.pretty(decodedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      const resolvedRule = decodeResolvedKeybindingFromConfigExit(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        const detail = Cause.pretty(resolvedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }
      keybindings.push(decodedRule.value);
    }

    return { keybindings, issues };
  });

  const allIntroducedIds = () => new Set(ADDED_KEYBINDING_DEFAULTS.map((entry) => entry.id));

  const readAppliedAdditionIds = Effect.gen(function* () {
    const exists = yield* fs.exists(keybindingsAppliedPath).pipe(Effect.orElseSucceed(() => false));
    // No file is the first run, and every addition is genuinely unoffered.
    if (!exists) return new Set<string>();

    const raw = yield* fs.readFileString(keybindingsAppliedPath).pipe(Effect.option);
    const decoded = raw._tag === "Some" ? decodeAppliedAdditionIdsExit(raw.value) : undefined;
    if (decoded && decoded._tag === "Success") return new Set(decoded.value);

    // A ledger that exists but cannot be read fails closed. The documented
    // contract is the deletion guarantee, not the delivery one: treating it as
    // empty would re-offer every addition and undo a shortcut the user removed,
    // while treating it as complete only costs an offer they can make by hand.
    yield* Effect.logWarning("keybinding offer ledger is unreadable; offering nothing this run", {
      path: keybindingsAppliedPath,
    });
    return allIntroducedIds();
  });

  const writeAppliedAdditionIds = (ids: ReadonlySet<string>) =>
    encodeAppliedAdditionIdsJson([...ids].toSorted()).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: keybindingsAppliedPath, contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      // A lost ledger write leaves the config ahead of the record: the
      // addition is in the file, but nothing remembers offering it. Delete the
      // shortcut before the next start and it comes back once. Startup must
      // not fail over bookkeeping, so this is logged rather than raised.
      Effect.tapCause(() =>
        Effect.logWarning("could not record keybinding offers; they may be offered again", {
          path: keybindingsAppliedPath,
        }),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const writeConfigAtomically = (rules: readonly KeybindingRule[]) => {
    return encodeKeybindingsConfigPrettyJson(rules).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({
          filePath: keybindingsConfigPath,
          contents: encoded,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );
  };

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => ({
      keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(keybindings)),
      issues,
    })),
  );

  const resolvedConfigCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const revalidateAndEmit = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      const configState = yield* loadConfigStateFromCacheOrDisk;
      yield* emitChange(configState);
    }),
  );

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const configExists = yield* readConfigExists;
      if (!configExists) {
        yield* writeConfigAtomically(DEFAULT_KEYBINDINGS);
        // The defaults already contain every introduced addition, so record
        // them as offered. Without this the next start reports each one as
        // "already present" and rewrites the file for no change.
        yield* writeAppliedAdditionIds(allIntroducedIds());
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadRuntimeCustomKeybindingsConfig();
      if (runtimeConfig.issues.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: keybindingsConfigPath,
            issues: runtimeConfig.issues,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }
      // Retired defaults are rewritten before the conflict scan below, so a
      // default whose key was freed by the rewrite is no longer seen as taken
      // and gets backfilled in the same startup rather than a later one.
      const migration = migrateRetiredKeybindingDefaults(runtimeConfig.keybindings);
      // Introduced defaults run after the rewrite so an addition can land on a
      // key the rewrite just freed.
      const appliedAdditionIds = yield* readAppliedAdditionIds;
      const additions = addIntroducedKeybindingDefaults({
        config: migration.config,
        appliedIds: appliedAdditionIds,
        capacity: MAX_KEYBINDINGS_COUNT,
        claimsShortcutContext: hasSameShortcutContext,
      });
      const customConfig = additions.config;
      for (const rewrite of migration.rewrites) {
        // Info rather than warning: the rewrite is expected and self-healing,
        // and it runs at most once per retired default.
        yield* Effect.logInfo("moved a retired default keybinding to its current key", {
          path: keybindingsConfigPath,
          command: rewrite.command,
          from: rewrite.fromKey,
          to: rewrite.toKey,
        });
      }
      for (const addition of additions.results) {
        switch (addition.outcome) {
          case "applied":
            yield* Effect.logInfo("added a keybinding default introduced in this release", {
              path: keybindingsConfigPath,
              command: addition.rule.command,
              key: addition.rule.key,
            });
            break;
          case "context-claimed":
            yield* Effect.logWarning("skipped an introduced keybinding default: its key is taken", {
              path: keybindingsConfigPath,
              command: addition.rule.command,
              key: addition.rule.key,
            });
            break;
          case "already-present":
            break;
        }
      }
      if (additions.deferred.length > 0) {
        // Not recorded, so these are offered again once the user frees space.
        yield* Effect.logWarning("deferring introduced keybinding defaults at max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
          commands: additions.deferred.map((entry) => entry.rule.command),
        });
      }
      for (const rewrite of migration.blocked) {
        yield* Effect.logWarning("kept a retired default keybinding: its new key is taken", {
          path: keybindingsConfigPath,
          command: rewrite.command,
          key: rewrite.fromKey,
          blockedBy: rewrite.toKey,
          reason: rewrite.reason,
        });
      }
      // Deliberately the pre-additions config. An addition is not evidence the
      // user has that command bound, and treating it as such would make the
      // backfill skip that command's other shipped defaults.
      const existingCommands = new Set(migration.config.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        key: string;
        when: string | null;
      }> = [];
      for (const defaultRule of DEFAULT_KEYBINDINGS) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        if (
          additions.results.some(
            (entry) => entry.outcome === "applied" && isSameKeybindingRule(entry.rule, defaultRule),
          )
        ) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            key: defaultRule.key,
            when: defaultRule.when ?? null,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }
      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          key: conflict.key,
          when: conflict.when,
          reason: "shortcut context already used by existing rule",
        });
      }
      const matchingDefaults = Array.filterMap(DEFAULT_KEYBINDINGS, (defaultRule) =>
        customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule))
          ? Result.succeed(defaultRule.command)
          : Result.failVoid,
      );
      if (matchingDefaults.length > 0) {
        yield* Effect.logWarning("default keybinding rule already defined in user config", {
          path: keybindingsConfigPath,
          commands: matchingDefaults,
        });
      }

      // Startup backfill must never evict persisted user rules: append only
      // the defaults that fit and skip the rest.
      const availableSlots = Math.max(0, MAX_KEYBINDINGS_COUNT - customConfig.length);
      const defaultsToAppend = missingDefaults.slice(0, availableSlots);
      const skippedDefaults = missingDefaults.slice(availableSlots);
      if (skippedDefaults.length > 0) {
        yield* Effect.logWarning("skipping default keybinding backfill at max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
          commands: skippedDefaults.map((rule) => rule.command),
        });
      }

      // One write site on purpose. A rewrite or an introduced default has to
      // reach disk even when there is nothing to append, or it is offered again
      // on the next startup; an early return added above this line would lose
      // it silently.
      const additionsChangedConfig = additions.results.some((entry) => entry.outcome === "applied");
      if (migration.rewrites.length > 0 || additionsChangedConfig || defaultsToAppend.length > 0) {
        yield* writeConfigAtomically([...customConfig, ...defaultsToAppend]);
      }
      // Record offers whether or not they landed. A skipped addition was
      // considered and declined; retrying it every boot would only re-log.
      if (additions.results.length > 0) {
        yield* writeAppliedAdditionIds(
          new Set([...appliedAdditionIds, ...additions.results.map((entry) => entry.id)]),
        );
      }
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);
    const keybindingsConfigFile = path.basename(keybindingsConfigPath);
    const keybindingsConfigPathResolved = path.resolve(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedKeybindingsEvents = fs.watch(keybindingsConfigDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === keybindingsConfigFile ||
          event.path === keybindingsConfigPath ||
          path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedKeybindingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const rule = keybindingRuleFromUpsertInput(input);
          const replaceTarget = replaceTargetFromUpsertInput(input);
          const nextConfig = [
            ...customConfig.filter((entry) => {
              if (replaceTarget) {
                return (
                  !isSameKeybindingRule(entry, replaceTarget) && !isSameKeybindingRule(entry, rule)
                );
              }
              return !isSameKeybindingRule(entry, rule);
            }),
            rule,
          ];
          const cappedConfig =
            nextConfig.length > MAX_KEYBINDINGS_COUNT
              ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
              : nextConfig;
          if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            yield* Effect.logWarning("truncating keybindings config to max entries", {
              path: keybindingsConfigPath,
              maxEntries: MAX_KEYBINDINGS_COUNT,
            });
          }
          yield* writeConfigAtomically(cappedConfig);
          const nextResolved = mergeWithDefaultKeybindings(
            compileResolvedKeybindingsConfig(cappedConfig),
          );
          yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, {
            keybindings: nextResolved,
            issues: [],
          });
          yield* emitChange({
            keybindings: nextResolved,
            issues: [],
          });
          return nextResolved;
        }),
      ),
    removeKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const target = keybindingRuleFromRemoveInput(input);
          const nextConfig = customConfig.filter((entry) => !isSameKeybindingRule(entry, target));
          yield* writeConfigAtomically(nextConfig);
          const nextResolved = mergeWithDefaultKeybindings(
            compileResolvedKeybindingsConfig(nextConfig),
          );
          yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, {
            keybindings: nextResolved,
            issues: [],
          });
          yield* emitChange({
            keybindings: nextResolved,
            issues: [],
          });
          return nextResolved;
        }),
      ),
  } satisfies Keybindings["Service"];
});

export const layer = Layer.effect(Keybindings, make);
