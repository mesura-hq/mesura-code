import { DICTATION_CONTEXT_KIND } from "@t3tools/contracts";
import { findDictationSlots } from "@t3tools/shared/dictationSlots";

/**
 * One literal line as editor content: its dictation markers become the composer's dictation
 * chip, and every other character stays text, however much it looks like Markdown or a link.
 */
export function literalLineContent(line: string): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const slot of findDictationSlots(line)) {
    if (slot.start > cursor) content.push({ type: "text", text: line.slice(cursor, slot.start) });
    content.push({
      type: "composer-context-reference",
      attrs: {
        kind: DICTATION_CONTEXT_KIND,
        contextId: slot.jobId,
        label: "Transcribing",
        source: slot.source,
      },
    });
    cursor = slot.end;
  }
  if (cursor < line.length) content.push({ type: "text", text: line.slice(cursor) });
  return content;
}
