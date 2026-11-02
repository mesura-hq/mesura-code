import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { formatAssistantCitationForComposer } from "~/composer-logic";
import { offsetOf, positionOf, projectPrompt } from "./composerProjection";

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
  it("collapses each inline token to one character that names its source", () => {
    const first = citation("first");
    const second = citation("second");
    const projection = projectPrompt(`${first}: why\n${second}: and this`);
    expect(projection.text.replace(/[\ue000-\uf8ff]/g, "")).toBe(": why\n: and this");
    expect([...projection.tokens.values()]).toEqual([first, second]);
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
