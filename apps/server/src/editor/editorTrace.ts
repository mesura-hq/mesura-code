// @effect-diagnostics nodeBuiltinImport:off - an append-only file written outside any Effect.
// @effect-diagnostics preferSchemaOverJson:off - the trace is free-form JSONL for a person to read.
// @effect-diagnostics globalDate:off - a wall-clock stamp on a line a person reads, not domain time.
import * as NodeFS from "node:fs";

import type { EditorSessionEvent } from "@t3tools/contracts";

/**
 * A record of what an editor session was asked and what it answered.
 *
 * Off unless `MESURA_EDITOR_TRACE` names a file. It exists for reproducing
 * editor defects that only show up under a person's hands: every call from a
 * client, how long it queued behind the thread's lock (`waitedMs`), how long
 * Neovim took to answer it (`tookMs`), and a summary of every event sent back.
 * A Neovim whose main loop is busy shows up as calls whose `tookMs` climbs into
 * seconds, which is what a frozen editor looks like from here.
 *
 * One JSON object per line, appended, never read back by the server.
 */
export interface EditorTrace {
  readonly enabled: boolean;
  readonly record: (entry: Record<string, unknown>) => void;
}

const DISABLED: EditorTrace = { enabled: false, record: () => undefined };

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
  };
}

/** What an outgoing event says, without the text it carries. */
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
