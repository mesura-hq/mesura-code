import * as Schema from "effect/Schema";
import { ForwardCompatibleArray, TrimmedString } from "./baseSchemas.ts";

export const MAX_KEYBINDING_VALUE_LENGTH = 64;
const MAX_KEYBINDING_WHEN_LENGTH = 256;
export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_SCRIPT_ID_LENGTH = 24;
export const MAX_KEYBINDINGS_COUNT = 256;

export const THREAD_JUMP_KEYBINDING_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const;
export type ThreadJumpKeybindingCommand = (typeof THREAD_JUMP_KEYBINDING_COMMANDS)[number];

export const MODEL_PICKER_JUMP_KEYBINDING_COMMANDS = [
  "modelPicker.jump.1",
  "modelPicker.jump.2",
  "modelPicker.jump.3",
  "modelPicker.jump.4",
  "modelPicker.jump.5",
  "modelPicker.jump.6",
  "modelPicker.jump.7",
  "modelPicker.jump.8",
  "modelPicker.jump.9",
] as const;
export type ModelPickerJumpKeybindingCommand =
  (typeof MODEL_PICKER_JUMP_KEYBINDING_COMMANDS)[number];

const THREAD_KEYBINDING_COMMANDS = [
  "thread.stop",
  "thread.steerQueuedMessage",
  "thread.previous",
  "thread.next",
  // The sidebar's page step, five threads at a time. Separate commands
  // rather than a modifier on the two above, because a command is what a
  // keybinding row can name and what a user can rebind.
  "thread.previousPage",
  "thread.nextPage",
  "thread.copyReference",
  "thread.settle",
  // Bound to no chord since the 2026-W35 sync: upstream's thread.settle owns
  // mod+shift+s and does the same thing. The handlers here stay until the two
  // are unified, which is follow-up work, not part of the merge.
  "thread.toggleSettled",
  "thread.pin",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
] as const;
export type ThreadKeybindingCommand = (typeof THREAD_KEYBINDING_COMMANDS)[number];

const MODEL_PICKER_KEYBINDING_COMMANDS = [
  "modelPicker.toggle",
  "modelPicker.previousProvider",
  "modelPicker.nextProvider",
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
] as const;
export type ModelPickerKeybindingCommand = (typeof MODEL_PICKER_KEYBINDING_COMMANDS)[number];

/**
 * Half-viewport reading scroll over the chat timeline. Half a viewport keeps
 * the other half on screen as a visual anchor, which is what stops a reader
 * losing their place in a long thread; a full-viewport jump does not.
 */
export const CHAT_SCROLL_KEYBINDING_COMMANDS = [
  "chat.scrollHalfPageUp",
  "chat.scrollHalfPageDown",
] as const;
export type ChatScrollKeybindingCommand = (typeof CHAT_SCROLL_KEYBINDING_COMMANDS)[number];

export const STATIC_KEYBINDING_COMMANDS = [
  // Directional pane focus. The application claims these in the capture
  // phase in every pane, the embedded editor and the terminal included, so a
  // chord means one thing wherever it is typed. See
  // apps/web/src/lib/usePaneNavigation.ts.
  "pane.focusLeft",
  "pane.focusRight",
  "pane.focusUp",
  "pane.focusDown",
  "sidebar.toggle",
  "terminal.toggle",
  "terminal.split",
  "terminal.splitVertical",
  "terminal.new",
  "terminal.close",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "rightPanel.close",
  "pullRequest.copyNumber",
  "diff.toggle",
  "preview.toggle",
  "preview.refresh",
  "preview.focusUrl",
  "preview.zoomIn",
  "preview.zoomOut",
  "preview.resetZoom",
  "commandPalette.toggle",
  "filePicker.toggle",
  "projectSearch.toggle",
  // Opens the project scope picker, which filters the sidebar's thread list to
  // one project. It writes the same state the sidebar's own dropdown writes, so
  // the two are one filter and not two. The rename warning below applies to this
  // id too: RETIRED_KEYBINDING_DEFAULTS matches on the command, so it can move a
  // rule's key but never carry it to a new command name.
  "projectScope.toggle",
  // Opens the thread search picker: every thread, in every project and every
  // environment, found by words that may come from the project name, the title
  // or the branch in any order. The command palette lists threads too, but it
  // matches one contiguous substring over those fields joined, so it cannot
  // find a thread from its project plus a word of its title. The rename
  // warning below applies to this id too.
  "threadSearch.toggle",
  "themeEditor.toggle",
  "composer.stash",
  "composer.host",
  "composer.effort",
  "composer.mode",
  "composer.workspace",
  "composer.previousWorktree",
  "composer.branch",
  // Fork additions, kept as one block after upstream's run rather than sorted
  // into it. Upstream keeps growing that run, and a fork id interleaved with it
  // turns every one of those additions into a conflict.
  //
  // (ADR-003) Upstream ships no keyboard route to attaching at all, so retiring
  // the fork's attachment stack would have taken the only one.
  "composer.attachFiles",
  // Reaches the Symmetria file tree in the files surface and leaves it again,
  // and opens the file manager over the window. The rename warning below
  // applies here too; this fork's one rename so far is carried by
  // RENAMED_KEYBINDING_COMMANDS in packages/shared.
  "fileTree.toggle",
  "fileTree.miller",
  "usage.peek",
  "chat.new",
  "chat.newLocal",
  "editor.openFavorite",
  "traitsPicker.toggle",
  // Both open a branch-toolbar control. The workspace one exists only while
  // the thread can still change workspace, which is why it has no counterpart
  // once a thread owns a worktree.
  "workspacePicker.toggle",
  "branchPicker.toggle",
  // Folds the agent's question prompt into its header so the thread behind it
  // is readable while the answer is still being composed. Reachable by click
  // from that header too; the shortcut exists because the question arrives
  // while the hands are on the keyboard.
  //
  // Never rename this id. It is written verbatim into every user's
  // keybindings.json on first startup, and RETIRED_KEYBINDING_DEFAULTS migrates
  // a rule's key only — it matches on the command, so it cannot carry a command
  // to a new name. A rename orphans the rule in every config that already has
  // it, silently.
  "question.toggleCollapse",
  // Opens the chat header's inline title rename for the open thread, the
  // same field a double-click on the title opens. Upstream has no keyboard
  // route to it. Kept out of THREAD_KEYBINDING_COMMANDS for the reason given
  // below. The rename warning above applies to this id too.
  "thread.rename",
  // Settle and un-settle in one command. Kept out of THREAD_KEYBINDING_COMMANDS
  // because that group is traversal, dispatched by the sidebar; this acts on the
  // open thread's lifecycle and is dispatched by the chat view. The rename
  // warning above applies to this id too.
  ...CHAT_SCROLL_KEYBINDING_COMMANDS,
  ...MODEL_PICKER_KEYBINDING_COMMANDS,
  ...THREAD_KEYBINDING_COMMANDS,
] as const;

export const SCRIPT_RUN_COMMAND_PATTERN = Schema.TemplateLiteral([
  Schema.Literal("script."),
  Schema.NonEmptyString.check(
    Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH),
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  ),
  Schema.Literal(".run"),
]);

export const KeybindingCommand = Schema.Union([
  Schema.Literals(STATIC_KEYBINDING_COMMANDS),
  SCRIPT_RUN_COMMAND_PATTERN,
]);
export type KeybindingCommand = typeof KeybindingCommand.Type;

export const KeybindingValue = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH),
);

export const KeybindingWhen = TrimmedString.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYBINDING_WHEN_LENGTH),
);
export const KeybindingRule = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});
export type KeybindingRule = typeof KeybindingRule.Type;

export const KeybindingsConfig = Schema.Array(KeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type KeybindingsConfig = typeof KeybindingsConfig.Type;

export const KeybindingShortcut = Schema.Struct({
  key: KeybindingValue,
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});
export type KeybindingShortcut = typeof KeybindingShortcut.Type;

const KeybindingWhenNodeRef = Schema.suspend(
  (): Schema.Codec<KeybindingWhenNode> => KeybindingWhenNode,
);
export const KeybindingWhenNode = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("identifier"),
    name: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("not"),
    node: KeybindingWhenNodeRef,
  }),
  Schema.Struct({
    type: Schema.Literal("and"),
    left: KeybindingWhenNodeRef,
    right: KeybindingWhenNodeRef,
  }),
  Schema.Struct({
    type: Schema.Literal("or"),
    left: KeybindingWhenNodeRef,
    right: KeybindingWhenNodeRef,
  }),
]);
export type KeybindingWhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: KeybindingWhenNode }
  | { type: "and"; left: KeybindingWhenNode; right: KeybindingWhenNode }
  | { type: "or"; left: KeybindingWhenNode; right: KeybindingWhenNode };

export const ResolvedKeybindingRule = Schema.Struct({
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst: Schema.optional(KeybindingWhenNode),
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
export type ResolvedKeybindingRule = typeof ResolvedKeybindingRule.Type;

/**
 * The command set grows over time, so a client may receive rules it cannot
 * represent (a command or `when` node added after that client shipped).
 * Decoding drops those rules instead of failing the whole payload —
 * rejecting the config would take down the connection over a shortcut the
 * client couldn't dispatch anyway.
 */
export const ResolvedKeybindingsConfig = ForwardCompatibleArray(ResolvedKeybindingRule).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);
export type ResolvedKeybindingsConfig = typeof ResolvedKeybindingsConfig.Type;

export class KeybindingsConfigError extends Schema.TaggedError<KeybindingsConfigError>()(
  "KeybindingsConfigParseError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unable to parse keybindings config at ${this.configPath}: ${this.detail}`;
  }
}
