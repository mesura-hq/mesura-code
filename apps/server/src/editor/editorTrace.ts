// @effect-diagnostics nodeBuiltinImport:off - an append-only file written outside any Effect.
// @effect-diagnostics preferSchemaOverJson:off - the trace is free-form JSONL for a person to read.
// @effect-diagnostics globalDate:off - a wall-clock stamp on a line a person reads, not domain time.
import * as NodeFS from "node:fs";

import type { EditorSessionEvent } from "@t3tools/contracts";

/**
 * An append-only JSONL trace of editor session calls (`waitedMs` on the thread's lock, `tookMs`
 * in Neovim) and the events sent back. Off unless `MESURA_EDITOR_TRACE` names a file.
 * Warning: `input` entries record every key typed while it is on.
 */
export interface EditorTrace {
  readonly enabled: boolean;
  readonly record: (entry: Record<string, unknown>) => void;
  readonly close: () => void;
}

const DISABLED: EditorTrace = { enabled: false, record: () => undefined, close: () => undefined };

export function makeEditorTrace(path: string | undefined): EditorTrace {
  if (path === undefined || path.trim() === "") return DISABLED;
  const stream = NodeFS.createWriteStream(path, { flags: "a" });
  // A trace that cannot be written must not take the editor with it.
  stream.on("error", () => undefined);
  return {
    enabled: true,
    record: (entry) => {
      stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    },
    close: () => stream.end(),
  };
}

/**
 * What an outgoing event says: its counts, with short excerpts of overlay,
 * command-line and message text rather than the file's text.
 */
export function summarizeEditorEvent(event: EditorSessionEvent): Record<string, unknown> {
  switch (event.type) {
    case "snapshot":
      return {
        type: event.type,
        lines: event.snapshot.lines.length,
        cursor: event.snapshot.cursor,
        mode: event.snapshot.mode,
        topline: event.snapshot.topline,
      };
    case "lines":
      return { type: event.type, first: event.first, last: event.last, count: event.lines.length };
    case "decorations":
      return {
        type: event.type,
        rows: event.rows.length,
        overlays: event.overlays.length,
        highlightRuns: event.highlightRuns.length,
        overlayText: event.overlays.slice(0, 5).map((overlay) => overlay.text.slice(0, 40)),
      };
    case "hlDefs":
      return { type: event.type, count: Object.keys(event.hlDefs).length };
    case "cmdline":
      return { type: event.type, cmdline: event.cmdline?.content ?? null };
    case "message":
      return { type: event.type, kind: event.kind, text: event.text.slice(0, 200) };
    default:
      return { ...event };
  }
}
