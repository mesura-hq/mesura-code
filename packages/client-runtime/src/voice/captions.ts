import type { LiveVoiceEvent } from "./protocol.ts";

export interface VoiceCaption {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Captions use the voice transcript, never the working agent's written messages. */
export function appendVoiceCaption(
  captions: ReadonlyArray<VoiceCaption>,
  event: LiveVoiceEvent,
  makeId: () => string,
): ReadonlyArray<VoiceCaption> {
  if (
    (event.type !== "session.input_transcript.delta" &&
      event.type !== "session.output_transcript.delta") ||
    !event.delta
  )
    return captions;

  const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
  const last = captions.at(-1);
  const continuing = last?.role === role;
  const text = Array.from((continuing ? last.text : "") + event.delta)
    .slice(-12_000)
    .join("");
  return continuing
    ? [...captions.slice(0, -1), { ...last, text }]
    : [...captions.slice(-29), { id: makeId(), role, text }];
}
