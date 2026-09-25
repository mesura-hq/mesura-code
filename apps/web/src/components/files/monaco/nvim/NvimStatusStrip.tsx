import type { EditorCmdline } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";

import { describeMode } from "./nvimMode.ts";
import { isErrorMessageKind } from "./nvimMessages.ts";
import { describeFallback, isSettingsFixable, type NvimFallback } from "./nvimFallback.ts";

/**
 * One row under the editor: the mode, the command line, and the last message.
 *
 * A modal editor that does not show its mode is a trap — the same keystroke
 * deletes a line or types a letter, and the only way to find out which is to
 * press it. The command line is the same problem one level up: `:` and `/`
 * take the keyboard entirely, and a host that does not draw them leaves the
 * developer typing into something they cannot see. Phase 8 adds the notice for
 * when Neovim could not start.
 *
 * Deliberately still: no transition, no animation. This is driven all day and
 * an indicator that moved on every `i` would be the most repetitive thing on
 * the screen.
 */
export function NvimStatusStrip({
  mode,
  jumping,
  cmdline,
  message,
  fallback,
  onRetry,
}: {
  readonly mode: string;
  readonly jumping: boolean;
  readonly cmdline: EditorCmdline | null;
  readonly message: { readonly kind: string; readonly text: string } | null;
  readonly fallback: NvimFallback | null;
  readonly onRetry: () => void;
}) {
  if (fallback !== null) {
    // The panel still edits — it is the plain editor it was before modal
    // editing existed — so this says what is not running and how to fix it
    // rather than reporting a failure the developer cannot act on.
    return (
      <div
        data-nvim-status-strip
        data-nvim-fallback
        className="flex h-6 shrink-0 items-center gap-2 border-t border-border/50 px-2 text-[11px] text-muted-foreground"
      >
        <span className="font-mono font-medium tracking-wide text-foreground">NEOVIM OFF</span>
        <span className="truncate">{describeFallback(fallback)}</span>
        {isSettingsFixable(fallback.reason) ? (
          <span className="shrink-0 text-muted-foreground/70">Settings → Appearance</span>
        ) : null}
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded px-1 text-foreground underline-offset-2 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      data-nvim-status-strip
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border/50 px-2 text-[11px] text-muted-foreground"
    >
      {jumping ? (
        // Neovim still reports normal mode while flash waits for a label, so
        // the strip says what the next key actually does.
        <span
          data-nvim-jumping
          className="flex items-center gap-1 font-mono font-medium tracking-wide text-amber-600 dark:text-amber-400"
        >
          <ZapIcon aria-hidden className="size-3 fill-current" />
          FLASH
        </span>
      ) : (
        <span className="font-mono font-medium tracking-wide text-foreground">
          {describeMode(mode)}
        </span>
      )}
      {cmdline === null ? null : <NvimCmdlineText cmdline={cmdline} />}
      {cmdline === null && message !== null ? (
        <span
          data-nvim-message
          className={`truncate font-mono ${
            isErrorMessageKind(message.kind) ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The command line, with the caret where Neovim says it is.
 *
 * Split around `pos` rather than drawn with a real caret: this is a row of
 * text, not an input, and a blinking caret here would be a second thing on
 * screen claiming to hold the keyboard.
 */
function NvimCmdlineText({ cmdline }: { readonly cmdline: EditorCmdline }) {
  const before = cmdline.content.slice(0, cmdline.pos);
  const under = cmdline.content.slice(cmdline.pos, cmdline.pos + 1);
  const after = cmdline.content.slice(cmdline.pos + 1);
  return (
    <span data-nvim-cmdline className="truncate font-mono text-foreground">
      {cmdline.prompt}
      {cmdline.firstc}
      {before}
      <span className="bg-foreground text-background">{under === "" ? " " : under}</span>
      {after}
    </span>
  );
}
