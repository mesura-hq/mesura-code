import * as Schema from "effect/Schema";
import { ForwardCompatibleArray, TrimmedString } from "./baseSchemas.ts";

export const MAX_KEYBINDING_VALUE_LENGTH = 64;
export const MAX_KEYBINDING_WHEN_LENGTH = 256;
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

export const THREAD_KEYBINDING_COMMANDS = [
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
] as const;
export type ThreadKeybindingCommand = (typeof THREAD_KEYBINDING_COMMANDS)[number];

export const MODEL_PICKER_KEYBINDING_COMMANDS = [
  "modelPicker.toggle",
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
  "sidebar.toggle",
  "terminal.toggle",
  "terminal.split",
  "terminal.splitVertical",
  "terminal.new",
  "terminal.close",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
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
  "themeEditor.toggle",
  "composer.stash",
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
  // Settle and un-settle in one command. Kept out of THREAD_KEYBINDING_COMMANDS
  // because that group is traversal, dispatched by the sidebar; this acts on the
  // open thread's lifecycle and is dispatched by the chat view. The rename
  // warning above applies to this id too.
  "thread.toggleSettled",
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

export class KeybindingsConfigError extends Schema.TaggedErrorClass<KeybindingsConfigError>()(
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
