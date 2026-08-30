import {
  SymmetriaComposerDraftId,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import { DraftId, type DraftSessionState, type useComposerDraftStore } from "../composerDraftStore";

export type ComposerDictationTarget = ScopedThreadRef | DraftId;
type ComposerDraftState = ReturnType<typeof useComposerDraftStore.getState>;

const threadRefsEqual = (left: ScopedThreadRef, right: ScopedThreadRef): boolean =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

export const dictationTargetsEqual = (
  left: SymmetriaDictationTarget,
  right: SymmetriaDictationTarget,
): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") {
    return left.environmentId === right.environmentId && left.threadId === right.threadId;
  }
  if (left.kind === "draft" && right.kind === "draft") {
    return (
      left.draftId === right.draftId && threadRefsEqual(left.futureThreadRef, right.futureThreadRef)
    );
  }
  return false;
};

export function captureDictationTarget(
  target: ComposerDictationTarget,
  draftSession: DraftSessionState | null,
): SymmetriaDictationTarget | null {
  if (typeof target !== "string") {
    return { kind: "thread", environmentId: target.environmentId, threadId: target.threadId };
  }
  if (draftSession === null) return null;
  return {
    kind: "draft",
    draftId: SymmetriaComposerDraftId.make(target),
    futureThreadRef: scopeThreadRef(draftSession.environmentId, draftSession.threadId),
  };
}

export type ResolvedDictationTarget =
  | {
      readonly ok: true;
      readonly target: ComposerDictationTarget;
      readonly targetKey: string;
      readonly sourceTargetKey: string | null;
    }
  | { readonly ok: false; readonly reason: "missing-target" | "ambiguous-target" };

export function resolveDictationTarget(
  target: SymmetriaDictationTarget,
  state: Pick<ComposerDraftState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  threadExists: (threadRef: ScopedThreadRef) => boolean,
): ResolvedDictationTarget {
  if (target.kind === "thread") {
    const threadRef = scopeThreadRef(target.environmentId, target.threadId);
    return threadExists(threadRef)
      ? {
          ok: true,
          target: threadRef,
          targetKey: scopedThreadKey(threadRef),
          sourceTargetKey: null,
        }
      : { ok: false, reason: "missing-target" };
  }

  const directSession = state.draftThreadsByThreadKey[target.draftId];
  const matchingSessions = Object.entries(state.draftThreadsByThreadKey).filter(
    ([, session]) =>
      session.environmentId === target.futureThreadRef.environmentId &&
      session.threadId === target.futureThreadRef.threadId,
  );

  if (directSession !== undefined) {
    const directRef = scopeThreadRef(directSession.environmentId, directSession.threadId);
    if (!threadRefsEqual(directRef, target.futureThreadRef)) {
      return { ok: false, reason: "ambiguous-target" };
    }
    if (directSession.promotedTo) {
      return threadRefsEqual(directSession.promotedTo, target.futureThreadRef) &&
        threadExists(target.futureThreadRef)
        ? {
            ok: true,
            target: target.futureThreadRef,
            targetKey: scopedThreadKey(target.futureThreadRef),
            sourceTargetKey: target.draftId,
          }
        : { ok: false, reason: "missing-target" };
    }
    return {
      ok: true,
      target: DraftId.make(target.draftId),
      targetKey: target.draftId,
      sourceTargetKey: null,
    };
  }

  if (matchingSessions.length > 1) return { ok: false, reason: "ambiguous-target" };
  if (matchingSessions.length === 1) {
    const [, matchingSession] = matchingSessions[0]!;
    if (
      matchingSession.promotedTo &&
      threadRefsEqual(matchingSession.promotedTo, target.futureThreadRef) &&
      threadExists(target.futureThreadRef)
    ) {
      return {
        ok: true,
        target: target.futureThreadRef,
        targetKey: scopedThreadKey(target.futureThreadRef),
        sourceTargetKey: matchingSessions[0]![0],
      };
    }
    return { ok: false, reason: "ambiguous-target" };
  }

  const promotedKey = scopedThreadKey(target.futureThreadRef);
  if (threadExists(target.futureThreadRef)) {
    return {
      ok: true,
      target: target.futureThreadRef,
      targetKey: promotedKey,
      sourceTargetKey: null,
    };
  }
  return { ok: false, reason: "missing-target" };
}

export function appendComposerTextAtEnd(current: string, text: string): string {
  if (text.length === 0) return current;
  return current.length > 0 && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`;
}
