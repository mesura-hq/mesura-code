/**
 * The web Run tab's model is the shared one, so the web pane and the Android
 * Factory screen show the same run. Only the chat's markdown file chips are
 * web-specific.
 */
import type { FactoryRoleTurn } from "@t3tools/client-runtime/factory/run-view";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

export * from "@t3tools/client-runtime/factory/run-view";

/**
 * A session's turn files as markdown the chat draws as file chips, one line
 * per turn. Paths are written by the composer's own serializer, so any legal
 * path (spaces, brackets, angle brackets, parentheses) stays one link.
 */
export function factoryTurnFilesMarkdown(turns: ReadonlyArray<FactoryRoleTurn>): string {
  return turns
    .map((turn) =>
      [
        `Turn ${turn.turn}:`,
        serializeComposerFileLink(turn.promptFile),
        turn.reportFile === null ? "running" : serializeComposerFileLink(turn.reportFile),
      ].join(" "),
    )
    .join("\n\n");
}
