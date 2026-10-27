import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { CommandId, MessageId, type DictationTarget } from "@t3tools/contracts";
import { armedDraftSendDecision, dictatedMessageText } from "@t3tools/client-runtime/dictation";
import { findDictationSlots, withVoicedPrefix } from "@t3tools/shared/dictationSlots";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { toastManager } from "~/components/ui/toast";
import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import {
  submitDirectedDictation,
  type DirectedSubmissionContext,
} from "./directedComposerSubmission";

/**
 * Send-when-ready: an armed draft sends by itself once its prompt holds no marker; the draft's
 * marker count decides, so a fill and a Discard both count. A marker the user deletes by hand
 * disarms the draft instead: the text around it was written to wait for that transcript. Every
 * send goes through the directed submission, so a thread the user left still sends. A question
 * card's answer is armed by request and submitted by the card, which owns the answer's validation.
 */

interface DraftSendState {
  readonly target: ComposerThreadTarget;
  /** Send as soon as no marker remains. */
  readonly armed: boolean;
  /** A transcript was filled into the draft since it was last sent: one `[voiced] ` prefix. */
  readonly voiced: boolean;
  /** The job last filled into the draft; its id is the send's command id. */
  readonly lastJobId: string | null;
  /** The markers the draft held at the last look, to tell a deleted marker from a filled one. */
  readonly markers?: ReadonlyArray<string>;
}

interface QuestionSendState {
  /** As `DraftSendState.markers`, across every answer of the request. */
  readonly markers?: ReadonlyArray<string>;
}

interface SendWhenReadyState {
  readonly drafts: Record<string, DraftSendState>;
  /** Question requests, by `pendingUserInputRequestKey`, to submit once no answer holds a marker. */
  readonly questions: Record<string, QuestionSendState>;
}

export const useSendWhenReadyStore = create(
  persist<SendWhenReadyState>(() => ({ drafts: {}, questions: {} }), {
    name: "mesura:dictation-send-when-ready:v1",
  }),
);

export function sendWhenReadyKey(target: ComposerThreadTarget): string {
  return typeof target === "string" ? target : scopedThreadKey(target);
}

function updateDraftSendState(target: ComposerThreadTarget, patch: Partial<DraftSendState>) {
  const key = sendWhenReadyKey(target);
  useSendWhenReadyStore.setState((state) => ({
    drafts: {
      ...state.drafts,
      [key]: {
        target,
        armed: false,
        voiced: false,
        lastJobId: null,
        ...state.drafts[key],
        ...patch,
      },
    },
  }));
}

function forgetDraftSendState(key: string) {
  useSendWhenReadyStore.setState((state) => {
    if (!(key in state.drafts)) return state;
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  });
}

export function armSendWhenReady(target: ComposerThreadTarget): void {
  const prompt = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  updateDraftSendState(target, { armed: true, markers: dictationMarkerIds(prompt) });
}

export function disarmSendWhenReady(target: ComposerThreadTarget): void {
  if (sendWhenReadyKey(target) in useSendWhenReadyStore.getState().drafts) {
    updateDraftSendState(target, { armed: false });
  }
}

/** Records a transcript filled into the draft; the next send carries the `[voiced] ` prefix. */
export function markDictationFilled(target: ComposerThreadTarget, jobId: string): void {
  updateDraftSendState(target, { voiced: true, lastJobId: jobId });
}

function isDictationVoiced(target: ComposerThreadTarget): boolean {
  return useSendWhenReadyStore.getState().drafts[sendWhenReadyKey(target)]?.voiced === true;
}

/** The draft's text as sent: one `[voiced] ` tag when it holds dictated text. */
export function withDictatedPrefix(target: ComposerThreadTarget, prompt: string): string {
  return prompt.trim() === "" ? prompt : withVoicedPrefix(prompt, isDictationVoiced(target));
}

export function useSendWhenReadyArmed(target: ComposerThreadTarget | null): boolean {
  return useSendWhenReadyStore(
    (state) => target !== null && state.drafts[sendWhenReadyKey(target)]?.armed === true,
  );
}

export function armQuestionSendWhenReady(requestKey: string): void {
  // The answers' markers are read by the check this arming triggers.
  useSendWhenReadyStore.setState((state) => ({
    questions: { ...state.questions, [requestKey]: {} },
  }));
}

export function trackQuestionMarkers(requestKey: string, markers: ReadonlyArray<string>): void {
  useSendWhenReadyStore.setState((state) =>
    requestKey in state.questions && !sameMarkers(state.questions[requestKey]?.markers, markers)
      ? { questions: { ...state.questions, [requestKey]: { markers } } }
      : state,
  );
}

export function disarmQuestionSendWhenReady(requestKey: string): void {
  useSendWhenReadyStore.setState((state) => {
    if (!(requestKey in state.questions)) return state;
    const questions = { ...state.questions };
    delete questions[requestKey];
    return { questions };
  });
}

export function useQuestionSendWhenReadyArmed(requestKey: string): boolean {
  return useSendWhenReadyStore((state) => requestKey in state.questions);
}

/** The job ids of the markers in `text`, once each, sorted. */
export function dictationMarkerIds(text: string): ReadonlyArray<string> {
  return [...new Set(findDictationSlots(text).map((slot) => slot.jobId))].toSorted();
}

function sameMarkers(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/** Markers dictation took out itself (a fill, a Discard, a switch to save) since the last look. */
const markersTakenOutByDictation = new Set<string>();

export function noteDictationMarkerTakenOut(jobId: string): void {
  markersTakenOutByDictation.add(jobId);
}

/**
 * Whether a marker seen at the last look is gone without dictation taking it out: the user
 * deleted it. `previous` is `undefined` before the first look, when nothing can be judged.
 */
export function dictationMarkerDeletedByHand(
  previous: ReadonlyArray<string> | undefined,
  current: ReadonlyArray<string>,
): boolean {
  // A marker back in the text (an undo) is not taken out any more.
  for (const jobId of current) markersTakenOutByDictation.delete(jobId);
  let deleted = false;
  for (const jobId of previous ?? []) {
    if (current.includes(jobId)) continue;
    if (!markersTakenOutByDictation.delete(jobId)) deleted = true;
  }
  return deleted;
}

/** What the composer on screen knows about the send (provider, model, pending plan). */
const submissionContextReaders = new Map<string, () => DirectedSubmissionContext | null>();

export function registerSendContextReader(
  target: ComposerThreadTarget,
  read: () => DirectedSubmissionContext | null,
): () => void {
  const key = sendWhenReadyKey(target);
  submissionContextReaders.set(key, read);
  return () => {
    if (submissionContextReaders.get(key) === read) submissionContextReaders.delete(key);
  };
}

function toDictationTarget(target: ComposerThreadTarget): Exclude<DictationTarget, null> {
  return typeof target === "string"
    ? { kind: "draft", draftId: target }
    : { kind: "thread", environmentId: target.environmentId, threadId: target.threadId };
}

const sending = new Set<string>();

/** Sends one armed draft. `true` asks for another look: the draft changed under the send. */
async function sendArmedDraft(
  key: string,
  entry: DraftSendState,
  prompt: string,
): Promise<boolean> {
  const result = await submitDirectedDictation({
    command: {
      commandId: CommandId.make(entry.lastJobId ?? randomUUID()),
      createdAt: new Date().toISOString(),
    },
    target: toDictationTarget(entry.target),
    composerTarget: entry.target,
    prompt: dictatedMessageText(prompt, isDictationVoiced(entry.target)),
    messageId: MessageId.make(randomUUID()),
    submissionContext: submissionContextReaders.get(key)?.() ?? null,
    stillWanted: () => useSendWhenReadyStore.getState().drafts[key]?.armed === true,
  });
  if (result.kind === "turn-dispatched") {
    forgetDraftSendState(key);
    return false;
  }
  // Edited while its uploads finished: still armed, it goes as edited once no marker remains.
  // Disarmed meanwhile: the look after it forgets the draft once it is empty.
  if (result.kind === "draft-changed" || result.kind === "withdrawn") return true;
  reportUnsent(
    entry.target,
    result.kind === "refused"
      ? "This thread cannot take it right now. The text is still in the draft."
      : "The provider did not start. The text is still in the draft.",
  );
  return false;
}

/** The draft stays as it is; the user sends it by hand once whatever blocked it is resolved. */
function reportUnsent(target: ComposerThreadTarget, description: string) {
  disarmSendWhenReady(target);
  toastManager.add({ type: "error", title: "The dictated message was not sent", description });
}

/**
 * Runs after every draft change: sends each armed draft whose markers are all gone, and forgets
 * the state of a draft that was emptied (sent or cleared), so its next message starts unvoiced.
 */
function checkDraftsAfterChange() {
  const { drafts } = useSendWhenReadyStore.getState();
  for (const [key, entry] of Object.entries(drafts)) {
    const inFlight = sending.has(key);
    const draft = useComposerDraftStore.getState().getComposerDraft(entry.target);
    const prompt = draft?.prompt ?? "";
    const markers = dictationMarkerIds(prompt);
    const deletedByHand = dictationMarkerDeletedByHand(entry.markers, markers);
    const hasAttachments = (draft?.images.length ?? 0) + (draft?.files.length ?? 0) > 0;
    const decision = armedDraftSendDecision({
      armed: entry.armed && !deletedByHand,
      prompt,
      hasAttachments,
    });
    if (decision === "forget" && !inFlight) {
      forgetDraftSendState(key);
      continue;
    }
    // Tracked while a send is in flight too: an edit then sends as `draft-changed` asks again.
    if (deletedByHand && entry.armed) {
      updateDraftSendState(entry.target, { armed: false, markers });
      continue;
    }
    if (!sameMarkers(entry.markers, markers)) updateDraftSendState(entry.target, { markers });
    if (inFlight || decision !== "send") continue;
    sending.add(key);
    void sendArmedDraft(key, entry, prompt)
      .catch((cause: unknown) => {
        reportUnsent(entry.target, cause instanceof Error ? cause.message : String(cause));
        return false;
      })
      .then((recheck) => {
        sending.delete(key);
        if (recheck) queueDraftCheck();
      });
  }
}

let checkQueued = false;
function queueDraftCheck() {
  if (checkQueued || Object.keys(useSendWhenReadyStore.getState().drafts).length === 0) return;
  // After the update that triggered it, so a marker placed through the editor has landed.
  checkQueued = true;
  queueMicrotask(() => {
    checkQueued = false;
    checkDraftsAfterChange();
  });
}
useComposerDraftStore.subscribe(queueDraftCheck);
