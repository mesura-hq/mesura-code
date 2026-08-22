import { assert, it } from "vite-plus/test";

import { deliverDictation, type ComposerWriter } from "./sttDelivery.ts";

// The delivery is a pure function rather than a hook on purpose. This repository
// has no `renderHook` anywhere, so a hook would be untestable in its own idiom,
// and AGENTS.md's taste rule puts the complexity at the boundary and keeps the
// UI dumb. The hook that calls this only supplies the writer.

type SubmitBehaviour = "dispatches" | "resolves-false" | "rejects";

const makeWriter = (
  behaviour: SubmitBehaviour = "dispatches",
): ComposerWriter & { placed: Array<string>; submitted: Array<string> } => {
  const placed: Array<string> = [];
  const submitted: Array<string> = [];
  return {
    placed,
    submitted,
    placePrompt: (text: string) => {
      placed.push(text);
    },
    submit: async (text: string) => {
      submitted.push(text);
      if (behaviour === "rejects") throw new Error("turn start failed");
      return behaviour !== "resolves-false";
    },
  };
};

// Acceptance: a well-formed request carrying text and submit disabled places
// that text in the composer of the conversation currently on screen.
it("places dictated text in the composer of the conversation on screen", async () => {
  const writer = makeWriter();

  const outcome = await deliverDictation(writer, { text: "arreglá el socket", submit: false });

  assert.deepEqual(writer.placed, ["arreglá el socket"]);
  assert.equal(outcome.kind, "placed");
});

// Phase 1 acceptance, and phase 2's criterion 5: this must not change when
// submitting is wired.
it("sends nothing to the model when the request does not ask for it", async () => {
  const writer = makeWriter();

  const outcome = await deliverDictation(writer, { text: "arreglá el socket", submit: false });

  assert.lengthOf(writer.submitted, 0);
  assert.equal(outcome.kind, "placed");
});

// Acceptance: a request arriving when no conversation is on screen returns a
// structured failure naming that cause. It is its own outcome and not an error,
// because nothing went wrong — there was simply nowhere to put the words.
it("reports the absence of a conversation on screen as its own outcome", async () => {
  const outcome = await deliverDictation(null, { text: "arreglá el socket", submit: false });

  assert.equal(outcome.kind, "no-conversation");
});

// Acceptance: a request carrying text with submit enabled places the text and
// starts the turn.
it("places the text and starts the turn when the request asks to send", async () => {
  const writer = makeWriter();

  const outcome = await deliverDictation(writer, { text: "mandá esto", submit: true });

  assert.deepEqual(writer.placed, ["mandá esto"]);
  assert.deepEqual(writer.submitted, ["mandá esto"]);
  assert.equal(outcome.kind, "placed-and-submitted");
});

// Acceptance: a failure to start the turn after a successful placement is
// reported as its own outcome. It is the case that matters most — the words are
// sitting in the composer and the shell kept no clipboard copy, so the operator
// has to be told where they ended up rather than that "something failed".
// The send is asynchronous, so a submit that resolves false must be read as a
// refusal and not as a dispatch. An earlier version discarded the promise and
// called every one of these a success.
it("reports a placement whose turn was refused as its own outcome", async () => {
  const writer = makeWriter("resolves-false");

  const outcome = await deliverDictation(writer, { text: "mandá esto", submit: true });

  assert.deepEqual(writer.placed, ["mandá esto"], "the text must still be in the composer");
  assert.equal(outcome.kind, "placed-not-submitted");
});

// A send that throws must reach the shell as a failure rather than as a
// rejection nobody handles.
it("reports a send that throws as not submitted", async () => {
  const writer = makeWriter("rejects");

  const outcome = await deliverDictation(writer, { text: "mandá esto", submit: true });

  assert.equal(outcome.kind, "placed-not-submitted");
});

// Placing has to come first. Submitting before the text is in the composer
// would send an empty turn, which is worse than not sending at all.
it("places before it submits", async () => {
  const order: Array<string> = [];
  const outcome = await deliverDictation(
    {
      placePrompt: () => order.push("place"),
      submit: async () => {
        order.push("submit");
        return true;
      },
    },
    { text: "mandá esto", submit: true },
  );

  assert.deepEqual(order, ["place", "submit"]);
  assert.equal(outcome.kind, "placed-and-submitted");
});
