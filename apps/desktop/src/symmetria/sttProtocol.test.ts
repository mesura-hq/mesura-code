import { assert, it } from "vite-plus/test";

import { formatReceipt, parseRendererOutcome, parseSttRequest } from "./sttProtocol.ts";

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

// Guard. The accepted set grew from two outcomes to four when submitting
// landed, and a typo in one of them falls through to `null` — the request then
// waits out the five-second deadline and is reported as `no-conversation`,
// mislabelling a delivery that may well have happened. Nothing else catches it.
it.each(["placed", "placed-and-submitted", "placed-not-submitted", "no-conversation"])(
  "accepts %s coming back from the window",
  (outcome) => {
    const parsed = parseRendererOutcome({ requestId: "stt-1", outcome });

    assert.isNotNull(parsed);
    assert.equal(parsed?.requestId, "stt-1");
    assert.equal(parsed?.outcome.kind, outcome);
  },
);

it("rejects an outcome it does not recognise, and a missing request id", () => {
  assert.isNull(parseRendererOutcome({ requestId: "stt-1", outcome: "placed_and_submitted" }));
  assert.isNull(parseRendererOutcome({ outcome: "placed" }));
  assert.isNull(parseRendererOutcome("placed"));
});

// Acceptance: the receipt distinguishes text placed from text placed and turn
// started. The shell shows the operator a different thing for each.
it("distinguishes a placement from a placement whose turn started", () => {
  const placed = JSON.parse(formatReceipt({ kind: "placed" })) as { outcome: string };
  const sent = JSON.parse(formatReceipt({ kind: "placed-and-submitted" })) as {
    ok: boolean;
    outcome: string;
  };

  assert.equal(placed.outcome, "placed");
  assert.equal(sent.outcome, "placed-and-submitted");
  assert.isTrue(sent.ok);
});

// Acceptance: a failure to start the turn after a successful placement is
// reported as its own outcome, naming that the text is still in the composer.
// Not `ok`, because the send the request asked for did not happen — but the
// detail has to say where the words went, since the shell kept no copy.
it("reports a placement whose turn did not start, and says where the text is", () => {
  const receipt = JSON.parse(formatReceipt({ kind: "placed-not-submitted" })) as {
    ok: boolean;
    outcome: string;
    detail?: string;
  };

  assert.isFalse(receipt.ok);
  assert.equal(receipt.outcome, "placed-not-submitted");
  assert.include(receipt.detail ?? "", "composer");
});

it("formats the absence of a conversation as a failure naming that cause", () => {
  const line = formatReceipt({ kind: "no-conversation" });
  const receipt = JSON.parse(line) as { ok: boolean; outcome: string };

  assert.isFalse(receipt.ok);
  assert.equal(receipt.outcome, "no-conversation");
});
