import { describeMode } from "./nvimMode.ts";

/**
 * One row under the editor saying which mode Neovim is in.
 *
 * A modal editor that does not show its mode is a trap: the same keystroke
 * deletes a line or types a letter, and the only way to find out which is to
 * press it. Phase 6 adds the command line and messages here; phase 8 adds the
 * notice for when Neovim could not start.
 *
 * Deliberately still: no transition, no animation. This is driven all day and
 * a mode indicator that moved on every `i` would be the most repetitive thing
 * on the screen.
 */
export function NvimStatusStrip({ mode }: { readonly mode: string }) {
  return (
    <div
      data-nvim-status-strip
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border/50 px-2 text-[11px] text-muted-foreground"
    >
      <span className="font-mono font-medium tracking-wide text-foreground">
        {describeMode(mode)}
      </span>
    </div>
  );
}
