/**
 * The wire shape Symmetria Shell already speaks, and the receipt it blocks on.
 *
 * `stt-inject.sh` writes one JSON line to a per-process Unix socket and waits
 * for one line back. In socket mode it deliberately never falls back to the
 * clipboard, so an exchange that is not answered does not degrade — it loses
 * the dictation. Every branch here therefore produces an answer, including the
 * ones that could not parse their input.
 *
 * Pure on purpose: no Electron import, no node import, so the parsing and the
 * receipt shaping are testable without a socket.
 */

/** A dictation the shell wants delivered. */
export type SttRequest = {
  readonly text: string;
  readonly submit: boolean;
};

export type SttErrorCode = "malformed-json" | "unknown-type" | "invalid-request";

export type SttParseResult =
  | { readonly ok: true; readonly request: SttRequest }
  | { readonly ok: false; readonly code: SttErrorCode; readonly detail: string };

/**
 * What delivery did. `no-conversation` is a failure but not an error: nothing
 * went wrong, there was simply nowhere to put the words. The shell needs the
 * two apart because only one of them is worth reporting as a fault.
 */
export type SttOutcome =
  | { readonly kind: "placed" }
  | { readonly kind: "no-conversation" }
  | { readonly kind: "error"; readonly code: SttErrorCode; readonly detail: string };

const MESSAGE_TYPE = "stt_inject";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseSttRequest(line: string): SttParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (cause) {
    return {
      ok: false,
      code: "malformed-json",
      detail: cause instanceof Error ? cause.message : "could not parse the line as JSON",
    };
  }

  if (!isRecord(decoded)) {
    return { ok: false, code: "invalid-request", detail: "expected a JSON object" };
  }

  // Name the type back. A bare "bad request" tells the shell nothing about
  // which of its emitters is the one sending a shape we do not serve.
  if (decoded["type"] !== MESSAGE_TYPE) {
    return {
      ok: false,
      code: "unknown-type",
      detail: `unrecognised message type ${JSON.stringify(decoded["type"])}`,
    };
  }

  const text = decoded["text"];
  if (typeof text !== "string") {
    return { ok: false, code: "invalid-request", detail: "text must be a string" };
  }

  return { ok: true, request: { text, submit: decoded["submit"] === true } };
}

export function formatReceipt(outcome: SttOutcome): string {
  switch (outcome.kind) {
    case "placed":
      return JSON.stringify({ ok: true, outcome: "placed" });
    case "no-conversation":
      return JSON.stringify({ ok: false, outcome: "no-conversation" });
    case "error":
      return JSON.stringify({ ok: false, outcome: outcome.code, detail: outcome.detail });
  }
}
