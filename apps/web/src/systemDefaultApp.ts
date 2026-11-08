import type { EditorId } from "@t3tools/contracts";

/**
 * Mesura: settings open host files outside any project (keybindings.json, the logs folder) with
 * the host's default app, never with an external editor. Mesura Code's own editor needs a thread.
 */
export function systemDefaultAppOnly(availableEditors: ReadonlyArray<EditorId>): EditorId[] {
  return availableEditors.filter((editorId) => editorId === "file-manager");
}
