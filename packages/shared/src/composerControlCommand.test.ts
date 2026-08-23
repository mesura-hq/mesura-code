import { describe, expect, it } from "vite-plus/test";

import {
  buildNativeComposerControlCommands,
  classifyComposerControlSubmission,
} from "./composerControlCommand.ts";

describe("native composer control commands", () => {
  it("advertises compact only when the provider supports native compaction", () => {
    expect(
      buildNativeComposerControlCommands({
        nativeContextCompaction: true,
        hasExistingSession: true,
      }),
    ).toEqual([
      {
        command: "compact",
        description: "Compact this chat's context",
        label: "/compact",
      },
    ]);
    expect(
      buildNativeComposerControlCommands({
        nativeContextCompaction: false,
        hasExistingSession: true,
      }),
    ).toEqual([]);
    expect(
      buildNativeComposerControlCommands({
        nativeContextCompaction: true,
        hasExistingSession: false,
      }),
    ).toEqual([]);
  });

  it("classifies only a standalone compact command without composed context", () => {
    expect(
      classifyComposerControlSubmission({
        text: " /compact ",
        attachmentCount: 0,
        hasSupplementalContext: false,
      }),
    ).toBe("compact-context");

    for (const input of [
      { text: "/COMPACT", attachmentCount: 0, hasSupplementalContext: false },
      { text: "/Compact", attachmentCount: 0, hasSupplementalContext: false },
      { text: "/compact please", attachmentCount: 0, hasSupplementalContext: false },
      { text: "/compact", attachmentCount: 1, hasSupplementalContext: false },
      { text: "/compact", attachmentCount: 0, hasSupplementalContext: true },
    ]) {
      expect(classifyComposerControlSubmission(input)).toBeNull();
    }
  });
});
