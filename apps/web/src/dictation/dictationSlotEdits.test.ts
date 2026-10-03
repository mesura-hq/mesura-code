import { DictationJobId } from "@t3tools/contracts";
import { formatDictationSlot } from "@t3tools/shared/dictationSlots";
import { describe, expect, it } from "vite-plus/test";

import { fillDictationSlotKeepingCaret } from "./dictationSlotEdits";

const JOB = "4b1e2f60-9c3d-4a7e-8f15-2d6c0b9a7e31";
const SLOT = formatDictationSlot(DictationJobId.make(JOB));

/** Fills with the caret at the `|` in `template`; returns the text with `|` at the new caret. */
function fillAtCaret(template: string, transcript: string): string {
  const caret = template.indexOf("|");
  const prompt = template.replace("|", "").replaceAll("<m>", SLOT);
  const expanded = template.slice(0, caret).replaceAll("<m>", SLOT).length;
  const result = fillDictationSlotKeepingCaret(prompt, expanded, JOB, transcript);
  if ("missing" in result) throw new Error("marker missing");
  return `${result.text.slice(0, result.expandedCursor)}|${result.text.slice(result.expandedCursor)}`;
}

describe("filling a marker keeps the caret", () => {
  it("dictation phase 4 regression: a caret after the marker moves with the transcript", () => {
    expect(fillAtCaret("Hello <m> big| world", "hola")).toBe("Hello hola big| world");
  });

  it("dictation phase 4 regression: a caret before the marker stays put", () => {
    expect(fillAtCaret("Hel|lo <m> world", "hola")).toBe("Hel|lo hola world");
  });

  it("dictation phase 4 regression: removing a copied marker after the caret does not move it", () => {
    expect(fillAtCaret("one <m> two| <m> three", "uno")).toBe("one uno two| three");
  });

  it("dictation phase 4 regression: a caret past both the marker and its copy shifts by both edits", () => {
    expect(fillAtCaret("one <m> two <m> three|", "uno")).toBe("one uno two three|");
  });
});
