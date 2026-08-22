import { assert, it } from "vite-plus/test";

import { deliverDictation, type ComposerWriter } from "./sttDelivery.ts";

// The delivery is a pure function rather than a hook on purpose. This repository
// has no `renderHook` anywhere, so a hook would be untestable in its own idiom,
// and AGENTS.md's taste rule puts the complexity at the boundary and keeps the
// UI dumb. The hook that will call this only supplies the writer.

const makeWriter = (): ComposerWriter & { placed: Array<string>; submits: number } => {
  const placed: Array<string> = [];
  let submits = 0;
  return {
    placed,
    get submits() {
      return submits;
    },
    placePrompt: (text: string) => {
      placed.push(text);
    },
    submit: () => {
      submits += 1;
    },
  };
};

// Acceptance: a well-formed request carrying text and submit disabled places
// that text in the composer of the conversation currently on screen.
it("places dictated text in the composer of the conversation on screen", () => {
  const writer = makeWriter();

  const outcome = deliverDictation(writer, { text: "arreglá el socket", submit: false });

  assert.deepEqual(writer.placed, ["arreglá el socket"]);
  assert.equal(outcome.kind, "placed");
});

// Acceptance: nothing is sent to the model by any path in this phase.
it("sends nothing to the model when the request does not ask for it", () => {
  const writer = makeWriter();

  deliverDictation(writer, { text: "arreglá el socket", submit: false });

  assert.equal(writer.submits, 0);
});

// Acceptance: a request arriving when no conversation is on screen returns a
// structured failure naming that cause. It is its own outcome and not an error,
// because nothing went wrong — there was simply nowhere to put the words.
it("reports the absence of a conversation on screen as its own outcome", () => {
  const outcome = deliverDictation(null, { text: "arreglá el socket", submit: false });

  assert.equal(outcome.kind, "no-conversation");
});
