import { assert, it } from "vite-plus/test";

import { createSttBridge, type SttDeliveryMessage } from "./sttBridge.ts";

const ids = () => {
  let n = 0;
  return () => `req-${(n += 1)}`;
};

// Acceptance: a request arriving when no conversation is on screen returns a
// structured failure naming that cause.
it("answers no-conversation when there is no window to hand the message to", async () => {
  const bridge = createSttBridge({ send: () => false, newRequestId: ids() });

  const outcome = await bridge.deliver({ text: "hola", submit: false }).answered;

  assert.equal(outcome.kind, "no-conversation");
});

it("resolves the request the window answers, matched by its id", async () => {
  const sent: Array<SttDeliveryMessage> = [];
  const bridge = createSttBridge({
    send: (message) => {
      sent.push(message);
      return true;
    },
    newRequestId: ids(),
  });

  const dispatch = bridge.deliver({ text: "hola", submit: false });
  assert.lengthOf(sent, 1);
  assert.equal(sent[0]!.requestId, dispatch.requestId);
  bridge.resolve(dispatch.requestId, { kind: "placed" });

  assert.deepEqual(await dispatch.answered, { kind: "placed" });
});

// An answer for an id nobody is waiting on must not throw: the window can
// answer twice if it is reloaded mid-flight, and a throw inside an IPC handler
// takes down more than this feature.
it("ignores an answer for an id nobody is waiting on", () => {
  const bridge = createSttBridge({ send: () => true, newRequestId: ids() });

  bridge.resolve("req-does-not-exist", { kind: "placed" });

  assert.isTrue(true);
});

// The pending map is shared by every dictation in flight, so a deadline firing
// for one request must not answer the others. An earlier version called
// abandonAll here, which meant two overlapping dictations lost the second one
// the moment the first ran out of time.
it("abandons one request without touching another in flight", async () => {
  const bridge = createSttBridge({ send: () => true, newRequestId: ids() });

  const first = bridge.deliver({ text: "uno", submit: false });
  const second = bridge.deliver({ text: "dos", submit: false });

  bridge.abandonOne(first.requestId);
  assert.deepEqual(await first.answered, { kind: "no-conversation" });

  // The second is still waiting, and the window can still serve it.
  bridge.resolve(second.requestId, { kind: "placed" });
  assert.deepEqual(await second.answered, { kind: "placed" });
});

it("answers every waiting request when the bridge is abandoned", async () => {
  const bridge = createSttBridge({ send: () => true, newRequestId: ids() });

  const first = bridge.deliver({ text: "uno", submit: false });
  const second = bridge.deliver({ text: "dos", submit: false });
  bridge.abandonAll();

  assert.deepEqual(await first.answered, { kind: "no-conversation" });
  assert.deepEqual(await second.answered, { kind: "no-conversation" });
});

// The deadline itself is the layer's, not the bridge's — the repository routes
// timers through Effect. `abandonOne` is the mechanism the layer calls when it
// fires, which is what the test above pins.
