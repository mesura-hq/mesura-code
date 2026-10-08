import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { formatAssistantCitationForComposer } from "~/composer-logic";
import { expandProjection, offsetOf, positionOf, projectPrompt } from "./composerProjection";

const citation = (text: string) =>
  formatAssistantCitationForComposer({
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text,
    start: 0,
    end: text.length,
    prefix: "",
    suffix: "",
  }).trimEnd();

describe("projectPrompt", () => {
  it("collapses each inline token to one character and expands it back", () => {
    const prompt = `${citation("first")}: why\n${citation("second")}: and this`;
    const projection = projectPrompt(prompt);
    expect(projection.text).toBe(": why\n: and this");
    expect(expandProjection(projection.text, projection.tokens)).toBe(prompt);
  });

  it("keeps each token's identity when a token before it is deleted", () => {
    const first = citation("first");
    const second = citation("second");
    const projection = projectPrompt(`${first}: a\n${second}: b`);
    // `dd` on the first line, as Vim leaves the text.
    const edited = projection.text.split("\n").slice(1).join("\n");
    expect(expandProjection(edited, projection.tokens)).toBe(`${second}: b`);
  });
});

describe("offsetOf and positionOf", () => {
  it("convert between Vim positions and offsets in both directions", () => {
    const text = "one\ntwo words\nthree";
    expect(offsetOf(text, 1, 4)).toBe(8);
    expect(positionOf(text, 8)).toEqual({ line: 1, col: 4 });
    expect(offsetOf(text, 9, 0)).toBe(text.length);
  });
});
