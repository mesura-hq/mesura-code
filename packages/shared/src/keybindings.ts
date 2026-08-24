import {
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  // Moved off mod+d so the reading scroll can take the vim pair mod+u/mod+d.
  // The move reaches existing configs through RETIRED_KEYBINDING_DEFAULTS
  // below, which startup applies before it backfills missing defaults.
  { key: "mod+shift+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "alt+u", command: "usage.peek" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  // Order matters for the label, not for matching: shortcutLabelForCommand
  // reports the last binding that wins, so the everywhere-works chord goes
  // last and alt+m stays the alternate.
  { key: "alt+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "alt+e", command: "traitsPicker.toggle", when: "!terminalFocus" },
  { key: "alt+w", command: "workspacePicker.toggle", when: "!terminalFocus" },
  { key: "alt+b", command: "branchPicker.toggle", when: "!terminalFocus" },
  { key: "mod+u", command: "chat.scrollHalfPageUp", when: "!terminalFocus" },
  { key: "mod+d", command: "chat.scrollHalfPageDown", when: "!terminalFocus" },
  { key: "mod+o", command: "editor.openFavorite" },
  // Browsers keep ctrl+tab for their own tab strip and never deliver it to a
  // page, so this pair reaches the desktop app only. It is listed first so the
  // bracket pair below is the one the UI reports as the shortcut: the label
  // resolver returns the last binding that wins, and naming a chord that half
  // the surfaces never receive would be a lie on the other half.
  //
  // Unlike the bracket pair, these are gated on terminal focus. Ghostty
  // encodes ctrl+tab and would otherwise both traverse threads and write the
  // key into the shell.
  { key: "ctrl+shift+tab", command: "thread.previous", when: "!terminalFocus" },
  { key: "ctrl+tab", command: "thread.next", when: "!terminalFocus" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
  })),
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "modelPickerOpen",
  })),
];

/**
 * Defaults that used to ship on a different key.
 *
 * Startup backfill only adds defaults for commands a config does not already
 * mention, so moving a default never reaches anyone who has run the app
 * before: their file keeps the old rule, and whatever took the freed key over
 * silently gets nothing. Each entry here lets startup rewrite that one rule.
 *
 * `from` must match a retired default exactly — key, command, and `when`
 * together. A rule that differs in any of the three is the user's own and is
 * left alone.
 */
export const RETIRED_KEYBINDING_DEFAULTS: ReadonlyArray<{
  readonly from: KeybindingRule;
  readonly toKey: string;
}> = [
  {
    // Freed for chat.scrollHalfPageDown; see the diff.toggle default above.
    from: { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
    toKey: "mod+shift+d",
  },
];

/**
 * Defaults introduced for a command that already shipped one.
 *
 * Startup backfill is per command, so a second default never reaches anyone
 * who has run the app before: their file already mentions the command, the
 * new rule is skipped, and the shortcut exists only on a fresh install.
 * Documenting that is not shipping it.
 *
 * Re-adding an *old* default would be wrong — the user may have deleted it on
 * purpose. A default introduced in a release carries no such history: it never
 * existed for them to remove, so adding it once is safe. "Once" is the whole
 * contract, which is why each entry has a stable id the server records after
 * applying it. Delete the shortcut afterwards and it stays deleted.
 *
 * Never edit an id, and never reuse one for a different rule: an installation
 * that already recorded it will skip the new rule forever.
 */
export interface AddedKeybindingDefault {
  readonly id: string;
  readonly rule: KeybindingRule;
  /**
   * The shipped default this addition must sit before, when the command has
   * more than one. Order decides the label, not the matching:
   * `shortcutLabelForCommand` reports the binding that wins, which is the last
   * one. Appending would make an upgraded install advertise a different chord
   * than a fresh one — and for `ctrl+tab`, one the web client never receives.
   */
  readonly insertBefore?: KeybindingRule;
}

export const ADDED_KEYBINDING_DEFAULTS: ReadonlyArray<AddedKeybindingDefault> = [
  {
    id: "2026-08-model-picker-alt-m",
    rule: { key: "alt+m", command: "modelPicker.toggle", when: "!terminalFocus" },
    insertBefore: { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  },
  {
    id: "2026-08-thread-next-ctrl-tab",
    rule: { key: "ctrl+tab", command: "thread.next", when: "!terminalFocus" },
    insertBefore: { key: "mod+shift+]", command: "thread.next" },
  },
  {
    id: "2026-08-thread-previous-ctrl-shift-tab",
    rule: { key: "ctrl+shift+tab", command: "thread.previous", when: "!terminalFocus" },
    insertBefore: { key: "mod+shift+[", command: "thread.previous" },
  },
];

export type IntroducedKeybindingAdditionOutcome =
  /** Appended to the config. */
  | "applied"
  /** The exact rule was already there, so nothing changed. */
  | "already-present"
  /** Another rule holds that chord; forcing it would disable one of the two. */
  | "context-claimed";

export interface IntroducedKeybindingAdditionResult {
  readonly id: string;
  readonly rule: KeybindingRule;
  readonly outcome: IntroducedKeybindingAdditionOutcome;
}

export interface IntroducedKeybindingDefaultsInput {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly appliedIds: ReadonlySet<string>;
  /** Largest config the caller may persist; additions stop at it. */
  readonly capacity: number;
  /**
   * Whether an existing rule holds a chord. Injected because the authoritative
   * comparison normalizes the chord first — `Alt+M`, `alt + m`, and `m+alt` are
   * one context — and that normalizer lives with the server's config codecs.
   */
  readonly claimsShortcutContext: (rule: KeybindingRule, candidate: KeybindingRule) => boolean;
}

/**
 * Appends every introduced default the ledger has not recorded yet.
 *
 * An addition is skipped, but still recorded, when its chord already belongs
 * to another rule: forcing it would put two commands on one chord and, under
 * last-wins resolution, quietly disable one. Recording the skip keeps startup
 * from retrying it on every boot.
 *
 * Additions dropped for lack of room come back in `deferred` and are NOT
 * recorded, so they are offered again once the user frees space.
 */
export function addIntroducedKeybindingDefaults(input: IntroducedKeybindingDefaultsInput): {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly results: ReadonlyArray<IntroducedKeybindingAdditionResult>;
  readonly deferred: ReadonlyArray<AddedKeybindingDefault>;
} {
  const next = [...input.config];
  const results: IntroducedKeybindingAdditionResult[] = [];
  const deferred: AddedKeybindingDefault[] = [];

  for (const addition of ADDED_KEYBINDING_DEFAULTS) {
    if (input.appliedIds.has(addition.id)) continue;

    if (next.some((entry) => isSameKeybindingRule(entry, addition.rule))) {
      results.push({ id: addition.id, rule: addition.rule, outcome: "already-present" });
      continue;
    }
    if (next.some((entry) => input.claimsShortcutContext(entry, addition.rule))) {
      results.push({ id: addition.id, rule: addition.rule, outcome: "context-claimed" });
      continue;
    }
    if (next.length >= input.capacity) {
      deferred.push(addition);
      continue;
    }

    const before = addition.insertBefore;
    const index = before ? next.findIndex((entry) => isSameKeybindingRule(entry, before)) : -1;
    if (index === -1) {
      next.push(addition.rule);
    } else {
      next.splice(index, 0, addition.rule);
    }
    results.push({ id: addition.id, rule: addition.rule, outcome: "applied" });
  }

  const applied = results.some((entry) => entry.outcome === "applied");
  return { config: applied ? next : input.config, results, deferred };
}

export interface RetiredKeybindingRewrite {
  readonly command: KeybindingRule["command"];
  readonly fromKey: string;
  readonly toKey: string;
}

export interface BlockedRetiredKeybindingRewrite extends RetiredKeybindingRewrite {
  readonly reason: "destination-claimed";
}

/** True when two rules bind the same command on the same shortcut context. */
export function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

function claimsShortcutContext(
  rule: KeybindingRule,
  key: string,
  when: string | undefined,
): boolean {
  return rule.key === key && (rule.when ?? undefined) === when;
}

/**
 * Rewrites any retired default still present in a user config onto its current
 * key. Returns the config unchanged when nothing moved, so callers can skip the
 * write.
 *
 * Three things keep this from damaging a config:
 *
 * - `from` must match a retired default exactly, so a rule the user edited in
 *   any of key, command, or `when` is left alone.
 * - A rewrite is skipped when the destination shortcut context already belongs
 *   to some other rule. Moving onto it would leave two rules on one chord, and
 *   since resolution is last-wins one of the two commands would quietly stop
 *   working — the same silent failure this function exists to remove. Those
 *   cases come back in `blocked` so the caller can say so.
 * - A rewritten rule no longer matches its `from`, which makes the pass
 *   idempotent, and rewrites that collapse onto an identical rule are deduped.
 */
export function migrateRetiredKeybindingDefaults(config: ReadonlyArray<KeybindingRule>): {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly rewrites: ReadonlyArray<RetiredKeybindingRewrite>;
  readonly blocked: ReadonlyArray<BlockedRetiredKeybindingRewrite>;
} {
  const rewrites: RetiredKeybindingRewrite[] = [];
  const blocked: BlockedRetiredKeybindingRewrite[] = [];
  const next: KeybindingRule[] = [];

  for (const rule of config) {
    const retired = RETIRED_KEYBINDING_DEFAULTS.find((entry) =>
      isSameKeybindingRule(entry.from, rule),
    );
    if (!retired) {
      next.push(rule);
      continue;
    }

    const destination = { ...rule, key: retired.toKey };
    const claimedByAnother = config.some(
      (entry) =>
        entry !== rule && claimsShortcutContext(entry, retired.toKey, rule.when ?? undefined),
    );
    if (claimedByAnother) {
      blocked.push({
        command: rule.command,
        fromKey: rule.key,
        toKey: retired.toKey,
        reason: "destination-claimed",
      });
      next.push(rule);
      continue;
    }

    // A config may hold the retired rule more than once; collapsing both onto
    // the destination would persist a duplicate.
    if (next.some((entry) => isSameKeybindingRule(entry, destination))) {
      continue;
    }

    rewrites.push({ command: rule.command, fromKey: rule.key, toKey: retired.toKey });
    next.push(destination);
  }

  return rewrites.length === 0
    ? { config, rewrites, blocked }
    : { config: next, rewrites, blocked };
}

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: ReadonlyArray<KeybindingRule>,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingRule[] = [];
  for (const rule of config) {
    const result = compileResolvedKeybindingRule(rule);
    if (result) {
      compiled.push(result);
    }
  }
  return compiled.slice(-MAX_KEYBINDINGS_COUNT);
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);
