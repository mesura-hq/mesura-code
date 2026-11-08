import { describe, expect, it } from "vite-plus/test";
import { appendVoiceCaption, type VoiceCaption } from "./captions.ts";

describe("voice captions", () => {
  it("keeps the spoken wording separate from the working agent's answer", () => {
    let captions: ReadonlyArray<VoiceCaption> = [];
    let id = 0;
    const makeId = () => String(++id);
    captions = appendVoiceCaption(
      captions,
      { type: "session.input_transcript.delta", delta: "How does " },
      makeId,
    );
    captions = appendVoiceCaption(
      captions,
      { type: "session.input_transcript.delta", delta: "it work?" },
      makeId,
    );
    captions = appendVoiceCaption(
      captions,
      { type: "session.output_transcript.delta", delta: " Here’s the short version." },
      makeId,
    );
    captions = appendVoiceCaption(
      captions,
      { type: "session.output_transcript.delta", delta: " Want an example?" },
      makeId,
    );
    expect(captions).toEqual([
      { id: "1", role: "user", text: "How does it work?" },
      { id: "2", role: "assistant", text: " Here’s the short version. Want an example?" },
    ]);
    expect(
      appendVoiceCaption(
        captions,
        {
          type: "session.delegation.created",
          offset_ms: 500,
          delegation: { id: "task", target: "client" },
        },
        makeId,
      ),
    ).toBe(captions);
  });

  it("keeps speaker changes and interruptions in transcript order", () => {
    let captions: ReadonlyArray<VoiceCaption> = [];
    for (const event of [
      { type: "session.output_transcript.delta", delta: "There are three ways" },
      { type: "session.input_transcript.delta", delta: "Wait. Only explain the first." },
      { type: "session.output_transcript.delta", delta: "Let’s start with the first." },
    ] as const)
      captions = appendVoiceCaption(captions, event, () => String(captions.length));
    expect(captions.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "assistant", text: "There are three ways" },
      { role: "user", text: "Wait. Only explain the first." },
      { role: "assistant", text: "Let’s start with the first." },
    ]);
  });

  it("ignores empty fragments without creating a new speaker", () => {
    const captions = [{ id: "first", role: "user" as const, text: "Hello" }];
    expect(
      appendVoiceCaption(
        captions,
        { type: "session.output_transcript.delta", delta: "" },
        () => "unused",
      ),
    ).toBe(captions);
  });

  it("bounds recent history and retains complete Unicode characters", () => {
    let captions: ReadonlyArray<VoiceCaption> = [];
    for (let i = 0; i < 40; i++)
      captions = appendVoiceCaption(
        captions,
        {
          type: i % 2 ? "session.input_transcript.delta" : "session.output_transcript.delta",
          delta: `${i}: ` + "🙂".repeat(12_001),
        },
        () => String(i),
      );
    expect(captions).toHaveLength(30);
    expect(captions[0]?.id).toBe("10");
    expect(captions.at(-1)?.text).toBe("🙂".repeat(12_000));
  });
});
