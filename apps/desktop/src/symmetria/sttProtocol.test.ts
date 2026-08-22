import { assert, it } from "vite-plus/test";

import { formatReceipt, parseSttRequest } from "./sttProtocol.ts";

// The shell writes one JSON line and blocks for one line back. It deliberately
// keeps no clipboard copy in socket mode, so an unanswered or unparseable
// exchange loses the dictation outright rather than degrading. Every branch
// below therefore has to produce an answer.

it("parses a well-formed dictation request", () => {
  const parsed = parseSttRequest(
    JSON.stringify({ type: "stt_inject", text: "hola", submit: false }),
  );

  assert.isTrue(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.request.text, "hola");
  assert.isFalse(parsed.request.submit);
});

// Acceptance: malformed JSON returns a structured error receipt rather than
// closing the connection or hanging.
it("rejects malformed JSON with a structured error", () => {
  const parsed = parseSttRequest("{ this is not json");

  assert.isFalse(parsed.ok);
  if (parsed.ok) return;
  assert.equal(parsed.code, "malformed-json");
});

// Acceptance: an unknown message type returns a structured error receipt naming
// the type it did not recognise. Naming it is the point — a bare "bad request"
// tells the shell nothing about which of its emitters is wrong.
it("names the message type it did not recognise", () => {
  const parsed = parseSttRequest(JSON.stringify({ type: "stt_recording", buf: 3 }));

  assert.isFalse(parsed.ok);
  if (parsed.ok) return;
  assert.equal(parsed.code, "unknown-type");
  assert.include(parsed.detail, "stt_recording");
});

it("rejects a request whose text is missing", () => {
  const parsed = parseSttRequest(JSON.stringify({ type: "stt_inject", submit: false }));

  assert.isFalse(parsed.ok);
  if (parsed.ok) return;
  assert.equal(parsed.code, "invalid-request");
});

it("formats every outcome as a single line of JSON", () => {
  const line = formatReceipt({ kind: "placed" });

  assert.notInclude(line, "\n");
  assert.deepEqual(JSON.parse(line), { ok: true, outcome: "placed" });
});

it("formats the absence of a conversation as a failure naming that cause", () => {
  const line = formatReceipt({ kind: "no-conversation" });
  const receipt = JSON.parse(line) as { ok: boolean; outcome: string };

  assert.isFalse(receipt.ok);
  assert.equal(receipt.outcome, "no-conversation");
});
