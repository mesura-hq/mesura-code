import type { KeybindingCommand } from "@t3tools/contracts";
import type { KeyBinding, KeyGroup, KeymapConfig } from "@mesura/keys/keymap";

/**
 * The default modal keymap; each binding's title is what which-key shows.
 *
 * Leader sequences reach every existing keybinding command by its id, so the
 * which-key menu doubles as a map of what the app can do. Commands outside
 * the keybinding catalog are the engine's own and are run by `keyEngine.ts`.
 */

export type EngineCommand =
  | "composer.insert"
  | "composer.append"
  | "keys.help"
  | "chat.cite"
  | "chat.previousUserMessage"
  | "chat.nextUserMessage"
  | "composer.toggleExpanded"
  | "flash.jump"
  | "pane.resizeMode";

interface CommandEntry {
  readonly title: string;
  readonly keys: string;
  readonly mode?: KeyBinding["mode"];
  readonly scope?: string;
}

/** Leader rows for existing keybinding commands, run through the command registry. */
const BRIDGED: ReadonlyArray<CommandEntry & { readonly command: KeybindingCommand }> = [
  { keys: "<leader><Space>", command: "filePicker.toggle", title: "Find file" },
  { keys: "<leader>ff", command: "filePicker.toggle", title: "File" },
  { keys: "<leader>fg", command: "projectSearch.toggle", title: "Grep project" },
  { keys: "<leader>fp", command: "projectScope.toggle", title: "Project scope" },
  { keys: "<leader>ft", command: "threadSearch.toggle", title: "Thread" },
  { keys: "<leader>fc", command: "commandPalette.toggle", title: "Command" },
  { keys: "<leader>tn", command: "chat.new", title: "New thread" },
  { keys: "<leader>tl", command: "chat.newLocal", title: "New local thread" },
  { keys: "<leader>tr", command: "thread.rename", title: "Rename" },
  { keys: "<leader>tp", command: "thread.pin", title: "Pin / unpin" },
  { keys: "<leader>ts", command: "thread.settle", title: "Settle / unsettle" },
  { keys: "<leader>ty", command: "thread.copyReference", title: "Copy reference" },
  { keys: "<leader>tq", command: "thread.steerQueuedMessage", title: "Steer queued message" },
  { keys: "]t", command: "thread.next", title: "Next thread" },
  { keys: "[t", command: "thread.previous", title: "Previous thread" },
  { keys: "<leader>pp", command: "rightPanel.toggle", title: "Toggle panel" },
  { keys: "<leader>pd", command: "diff.toggle", title: "Diff" },
  { keys: "<leader>pb", command: "preview.toggle", title: "Browser preview" },
  { keys: "<leader>pe", command: "fileTree.toggle", title: "File tree" },
  { keys: "<leader>pm", command: "fileTree.miller", title: "File manager" },
  { keys: "<leader>pt", command: "terminal.toggle", title: "Terminal" },
  { keys: "<leader>px", command: "rightPanel.close", title: "Close panel" },
  { keys: "<leader>b", command: "sidebar.toggle", title: "Toggle sidebar" },
  { keys: "<leader>mm", command: "modelPicker.toggle", title: "Model" },
  { keys: "<leader>me", command: "traitsPicker.toggle", title: "Effort & traits" },
  { keys: "<leader>ma", command: "composer.mode", title: "Agent mode" },
  { keys: "<leader>mh", command: "composer.host", title: "Host" },
  { keys: "<leader>ms", command: "composer.stash", title: "Stash prompt" },
  { keys: "<leader>mf", command: "composer.attachFiles", title: "Attach files" },
  { keys: "<leader>mw", command: "workspacePicker.toggle", title: "Workspace" },
  { keys: "<leader>mb", command: "branchPicker.toggle", title: "Branch" },
  { keys: "<leader>mq", command: "question.toggleCollapse", title: "Question" },
  { keys: "<leader>o", command: "editor.openFavorite", title: "Open in editor" },
];

const NATIVE: ReadonlyArray<CommandEntry & { readonly command: EngineCommand }> = [
  { keys: "i", command: "composer.insert", title: "Insert in composer", mode: "normal" },
  { keys: "a", command: "composer.append", title: "Append in composer", mode: "normal" },
  { keys: "<leader>?", command: "keys.help", title: "All keys" },
  {
    keys: "<leader>c",
    command: "chat.cite",
    title: "Cite selection",
    mode: "visual",
    scope: "chat",
  },
  { keys: "s", command: "flash.jump", title: "Flash", mode: ["normal", "visual"], scope: "chat" },
  {
    keys: "s",
    command: "flash.jump",
    title: "Flash",
    mode: ["normal", "visual"],
    scope: "composer",
  },
  {
    keys: "[u",
    command: "chat.previousUserMessage",
    title: "Your previous message",
    mode: "normal",
  },
  { keys: "]u", command: "chat.nextUserMessage", title: "Your next message", mode: "normal" },
  { keys: "<leader>e", command: "composer.toggleExpanded", title: "Expand composer" },
  { keys: "<leader>w", command: "pane.resizeMode", title: "Resize panes" },
];

const GROUPS: readonly KeyGroup[] = [
  { keys: "<leader>f", label: "find" },
  { keys: "<leader>t", label: "thread" },
  { keys: "<leader>p", label: "panel" },
  { keys: "<leader>m", label: "composer" },
  { keys: "]", label: "next" },
  { keys: "[", label: "previous" },
];

export const DEFAULT_KEYMAP: KeymapConfig = {
  leader: "<Space>",
  groups: GROUPS,
  bindings: [...BRIDGED, ...NATIVE].map((entry): KeyBinding => ({
    mode: entry.mode ?? ["normal", "visual"],
    keys: entry.keys,
    command: entry.command,
    label: entry.title,
    ...(entry.scope ? { scope: entry.scope } : {}),
  })),
};

const NATIVE_COMMANDS = new Set<string>(NATIVE.map((entry) => entry.command));

export function isEngineCommand(command: string): command is EngineCommand {
  return NATIVE_COMMANDS.has(command);
}
