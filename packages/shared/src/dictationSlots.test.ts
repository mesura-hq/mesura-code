// Entry point under test: the `@t3tools/shared/dictationSlots` subpath export, which web and
// mobile import. Criterion 1 also goes through the existing context-reference parser.
import { DictationJobId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  countPendingDictationSlots,
  fillDictationSlot,
  findDictationSlots,
  formatDictationSlot,
  withVoicedPrefix,
} from "@t3tools/shared/dictationSlots";

const marker = (jobId: string) => `[Transcribing](t3-context://v1/dictation/${jobId})`;
const terminalLink = "[Build output](t3-context://v1/terminal/terminal_job-1)";
const imageLink = "![shot.png](t3-context://v1/image/img-1)";
const fileLink = "[notes.md](t3-context://v1/file/file-1)";
const skillLink = "[review](t3-context://v1/skill/skill-1)";

describe("dictation slot format", () => {
  it("serializes a dictation marker as a Transcribing context link", () => {
    expect(formatDictationSlot(DictationJobId.make("job-1"))).toBe(
      "[Transcribing](t3-context://v1/dictation/job-1)",
    );
  });

  it("is found again by the existing context-reference parser", () => {
    const text = `say ${formatDictationSlot(DictationJobId.make("job-1"))} now`;
    const [occurrence, ...rest] = collectComposerContextReferences(text);
    expect(rest).toEqual([]);
    expect(occurrence).toMatchObject({
      kind: "dictation",
      contextId: "job-1",
      label: "Transcribing",
      image: false,
      start: 4,
      end: 4 + marker("job-1").length,
    });
  });

  it("round-trips a dictation marker at the 128-character job id limit", () => {
    const jobId = DictationJobId.make(`job-${"a".repeat(124)}`);
    expect(findDictationSlots(`x ${formatDictationSlot(jobId)}`).map((slot) => slot.jobId)).toEqual(
      [jobId],
    );
  });

  it("finds dictation markers by job id and ignores other context links", () => {
    const text = `${terminalLink} a ${marker("job-1")} b ${imageLink} ${marker("job-2")}`;
    expect(findDictationSlots(text).map((slot) => slot.jobId)).toEqual(["job-1", "job-2"]);
  });
});

describe("dictation slot fill", () => {
  it.each([
    { label: "joined words", before: `hello${marker("job-1")}world`, after: "hello said it world" },
    {
      label: "spaced words",
      before: `hello ${marker("job-1")} world`,
      after: "hello said it world",
    },
    { label: "alone", before: marker("job-1"), after: "said it" },
    { label: "before a period", before: `end${marker("job-1")}.`, after: "end said it." },
    { label: "before a comma", before: `a${marker("job-1")}, b`, after: "a said it, b" },
    { label: "before a semicolon", before: `a${marker("job-1")};`, after: "a said it;" },
    { label: "before a colon", before: `a${marker("job-1")}:`, after: "a said it:" },
    { label: "before a bang", before: `a${marker("job-1")}!`, after: "a said it!" },
    { label: "before a question mark", before: `a${marker("job-1")}?`, after: "a said it?" },
    { label: "before a closing paren", before: `(a${marker("job-1")})`, after: "(a said it)" },
    { label: "between line breaks", before: `a\n${marker("job-1")}\nb`, after: "a\nsaid it\nb" },
    { label: "after a tab", before: `a\t${marker("job-1")}`, after: "a\tsaid it" },
  ])("fills a dictation marker $label with spacing only where needed", ({ before, after }) => {
    expect(fillDictationSlot(before, "job-1", "said it")).toEqual({ text: after });
  });

  it("fills exactly the named dictation marker and leaves other links untouched", () => {
    const text = `${terminalLink} ${marker("job-1")} ${marker("job-2")} ${fileLink}`;
    expect(fillDictationSlot(text, "job-2", "second")).toEqual({
      text: `${terminalLink} ${marker("job-1")} second ${fileLink}`,
    });
  });

  it("does not fill a non-dictation link that shares the job id", () => {
    const text = `${terminalLink} ${marker("job-1")}`;
    expect(fillDictationSlot(text, "terminal_job-1", "nope")).toEqual({ missing: true });
  });
});

describe("dictation slot copies", () => {
  it.each([
    {
      label: "separated by prose",
      before: `x ${marker("job-1")} y ${marker("job-1")} z`,
      after: "x said it y z",
    },
    {
      label: "adjacent",
      before: `x ${marker("job-1")}${marker("job-1")} z`,
      after: "x said it z",
    },
    {
      label: "joined to words on both sides",
      before: `x ${marker("job-1")} y${marker("job-1")}z`,
      after: "x said it y z",
    },
    {
      label: "at the end",
      before: `x ${marker("job-1")} y ${marker("job-1")}`,
      after: "x said it y",
    },
    {
      label: "before a period",
      before: `x ${marker("job-1")} y${marker("job-1")}.`,
      after: "x said it y.",
    },
  ])(
    "fills the first copy of a dictation marker and removes copies $label",
    ({ before, after }) => {
      expect(fillDictationSlot(before, "job-1", "said it")).toEqual({ text: after });
    },
  );

  it("removes copies of the filled job only, keeping other jobs pending", () => {
    const text = `${marker("job-1")} a ${marker("job-2")} b ${marker("job-1")} c`;
    const filled = fillDictationSlot(text, "job-1", "said it");
    expect(filled).toEqual({ text: `said it a ${marker("job-2")} b c` });
    if (!("text" in filled)) throw new Error("expected a fill");
    expect(countPendingDictationSlots(filled.text)).toBe(1);
    expect(fillDictationSlot(filled.text, "job-1", "again")).toEqual({ missing: true });
  });
});

describe("dictation slot missing", () => {
  it("reports missing when the dictation marker is no longer in the text", () => {
    const text = `the user deleted it ${marker("job-2")}`;
    const result = fillDictationSlot(text, "job-1", "late transcript");
    expect(result).toEqual({ missing: true });
    expect(text).toBe(`the user deleted it ${marker("job-2")}`);
  });

  it("reports missing for empty text", () => {
    expect(fillDictationSlot("", "job-1", "late transcript")).toEqual({ missing: true });
  });
});

describe("dictation slot pending count", () => {
  it("counts only dictation markers among every other kind of context link", () => {
    const text = [
      terminalLink,
      imageLink,
      fileLink,
      skillLink,
      "[Transcribing](t3-context://v1/mention/job-9)",
      marker("job-1"),
      marker("job-2"),
    ].join(" ");
    expect(countPendingDictationSlots(text)).toBe(2);
  });

  it("counts zero dictation markers in prose and in non-dictation links", () => {
    expect(countPendingDictationSlots("")).toBe(0);
    expect(countPendingDictationSlots("plain [Transcribing](https://example.com)")).toBe(0);
    expect(countPendingDictationSlots(`${terminalLink} ${imageLink}`)).toBe(0);
  });
});

describe("dictation voiced prefix", () => {
  it("adds one voiced prefix when a marker was filled since the last send", () => {
    expect(withVoicedPrefix("fix the build", true)).toBe("[voiced] fix the build");
  });

  it("adds no voiced prefix when nothing was dictated", () => {
    expect(withVoicedPrefix("fix the build", false)).toBe("fix the build");
  });

  it("never stacks a second voiced prefix", () => {
    expect(withVoicedPrefix("[voiced] fix the build", true)).toBe("[voiced] fix the build");
  });
});

describe("dictation send readiness", () => {
  it.each([
    { label: "alone", text: marker("job-1") },
    { label: "after prose", text: `fix the build ${marker("job-1")}` },
    { label: "beside other context", text: `${imageLink} ${marker("job-1")} ${terminalLink}` },
    { label: "after a filled marker", text: `filled text ${marker("job-2")}` },
  ])("a prompt holding a dictation marker $label is never ready to send", ({ text }) => {
    expect(countPendingDictationSlots(text)).toBeGreaterThan(0);
  });
});
