import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { isKeybindingCaptureTarget } from "~/components/sidebar/AccountLimitsPanel.logic";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { resolveShortcutCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { useDictationJobs } from "~/state/dictation";
import { primaryServerKeybindingsAtom } from "~/state/server";
import type { DirectedSubmissionContext } from "~/symmetria/directedComposerSubmission";
import {
  deliverDictationJobs,
  isDictationKeybindingCommand,
  registerDictationComposer,
  runDictationKeybindingCommand,
} from "./dictationController";
import { useOwnDictationJobsStore } from "./dictationSessionStore";
import { registerSendContextReader } from "./sendWhenReady";

/**
 * Makes this composer the one a stopped recording drops its marker into, and lends a
 * send-when-ready send from it what the composer knows about the provider.
 */
export function useDictationComposer(input: {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly readSubmissionContext: () => DirectedSubmissionContext | null;
}): void {
  const { environmentId, composerDraftTarget, composerRef, readSubmissionContext } = input;
  useEffect(
    () => registerSendContextReader(composerDraftTarget, readSubmissionContext),
    [composerDraftTarget, readSubmissionContext],
  );
  useEffect(
    () =>
      registerDictationComposer({
        environmentId,
        target:
          typeof composerDraftTarget === "string"
            ? { kind: "draft", draftId: composerDraftTarget }
            : {
                kind: "thread",
                environmentId: composerDraftTarget.environmentId,
                threadId: composerDraftTarget.threadId,
              },
        draftTarget: composerDraftTarget,
        insertSlot: (slot) => composerRef.current?.insertDictationSlot(slot) ?? false,
      }),
    [composerDraftTarget, composerRef, environmentId],
  );
}

/**
 * Delivers this client's transcripts from one environment as the server reports them. Nothing
 * runs before the subscription's snapshot: an empty list then means "not known yet", not "no
 * jobs", and judging it would spend the one chance a reload has to give the mode keys back
 * the job that is still transcribing.
 */
export function useDictationDelivery(environmentId: EnvironmentId): void {
  const { jobs, loaded } = useDictationJobs(environmentId);
  useEffect(() => {
    if (loaded) deliverDictationJobs(environmentId, jobs);
  }, [environmentId, jobs, loaded]);
}

/**
 * The dictation keys, claimed in the capture phase so Alt+Enter selects a mode instead of
 * reaching the composer. They resolve only while `dictationActive` holds, which is what leaves
 * Alt+S to the Hosts peek the rest of the time.
 */
export function useDictationKeybindings(): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isKeybindingCaptureTarget(event.target)) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (!command || !isDictationKeybindingCommand(command)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) runDictationKeybindingCommand(command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);
}

/**
 * The environments this device dictated into recently; only these are subscribed. Handled jobs
 * count too: another tab may have handled a job whose marker this tab's draft still holds.
 */
export function useDictationEnvironments(): ReadonlyArray<EnvironmentId> {
  const environmentIds = useOwnDictationJobsStore(
    useShallow((state) => Object.values(state.jobs).map((job) => job.environmentId)),
  );
  return useMemo(() => [...new Set(environmentIds)], [environmentIds]);
}
