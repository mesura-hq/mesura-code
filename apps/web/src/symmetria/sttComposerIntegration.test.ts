import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, assert, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { deliverDictation, type ComposerWriter } from "./sttDelivery.ts";

// Every other test in this directory drives `deliverDictation` against a spy
// writer, which proves the mapping and nothing about where the words land. This
// file closes that gap: the writer here is built exactly as `ChatView` builds
// it — a real `setPrompt` against the real store — and the assertion reads the
// text back through `getComposerDraft`, the accessor the composer itself uses.
//
// It is not the rendered Lexical editor, and it does not claim to be. It is the
// data path between them, which is the part that was previously verified by
// nobody: the independent witness could not reach the renderer at all, and the
// spy-writer specs could not tell a correct key from a wrong one.

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-dictation");
const OTHER_THREAD_ID = ThreadId.make("thread-somewhere-else");

const writerFor = (
  target: Parameters<ReturnType<typeof useComposerDraftStore.getState>["setPrompt"]>[0],
): ComposerWriter => ({
  placePrompt: (text: string) => useComposerDraftStore.getState().setPrompt(target, text),
  submit: async () => true,
});

const promptAt = (
  target: Parameters<ReturnType<typeof useComposerDraftStore.getState>["getComposerDraft"]>[0],
): string | undefined => useComposerDraftStore.getState().getComposerDraft(target)?.prompt;

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
});

it("puts the dictated text where the composer reads it", async () => {
  const target = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);

  const outcome = await deliverDictation(writerFor(target), {
    text: "arreglá el socket",
    submit: false,
  });

  assert.equal(outcome.kind, "placed");
  assert.equal(promptAt(target), "arreglá el socket");
});

// The defect this pins: the writer originally wrote to `routeThreadRef` while
// the composer reads through `composerDraftTarget`, which differ on a draft
// route. A spy writer cannot see that — both are "a key" — so nothing in the
// suite would have failed. Writing to one key and reading the other must come
// back empty, which is what makes the correct-key test above mean something.
it("does not reach a conversation it was not addressed to", async () => {
  const addressed = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);
  const other = scopeThreadRef(ENVIRONMENT_ID, OTHER_THREAD_ID);

  await deliverDictation(writerFor(addressed), { text: "para esta", submit: false });

  assert.equal(promptAt(addressed), "para esta");
  assert.isUndefined(promptAt(other));
});

it("replaces whatever the composer already held", async () => {
  const target = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);
  useComposerDraftStore.getState().setPrompt(target, "lo que habia antes");

  await deliverDictation(writerFor(target), { text: "el dictado nuevo", submit: false });

  assert.equal(promptAt(target), "el dictado nuevo");
});

// Phase 2, criterion 1's near end: with submit enabled the text must be in the
// composer BEFORE the send runs, or the turn goes out empty. The spy-writer
// spec asserts the call order; this one asserts the store actually holds the
// text at the moment submit is entered.
it("has the text in the composer before the send runs", async () => {
  const target = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);
  let promptWhenSubmitRan: string | undefined;

  const outcome = await deliverDictation(
    {
      placePrompt: (text: string) => useComposerDraftStore.getState().setPrompt(target, text),
      submit: async () => {
        promptWhenSubmitRan = promptAt(target);
        return true;
      },
    },
    { text: "mandá esto", submit: true },
  );

  assert.equal(promptWhenSubmitRan, "mandá esto");
  assert.equal(outcome.kind, "placed-and-submitted");
});
