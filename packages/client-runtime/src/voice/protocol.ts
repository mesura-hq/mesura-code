export type LiveVoiceEvent =
  | { readonly type: "session.started" }
  | { readonly type: "session.closed" }
  | {
      readonly type: "session.input_transcript.delta";
      readonly delta: string;
      readonly start_ms?: number;
      readonly end_ms?: number;
    }
  | {
      readonly type: "session.output_transcript.delta";
      readonly delta: string;
      readonly start_ms?: number;
      readonly end_ms?: number;
    }
  | {
      readonly type: "session.delegation.created";
      readonly offset_ms: number;
      readonly delegation: { readonly id: string; readonly target: string };
    }
  | { readonly type: "error"; readonly error: { readonly message: string } };
