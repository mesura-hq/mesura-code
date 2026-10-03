import {
  SymmetriaDictationSessionId,
  type SymmetriaDictationSession,
} from "@symmetria/broker-contract";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { DictationStripBanner } from "~/symmetria/DictationStrip";
import {
  cancelDictation,
  cycleDictationMode,
  restartDictation,
  startDictation,
  stopDictation,
  toggleDictationPause,
} from "./dictationController";
import {
  recordedDictationMs,
  type DictationRecordingSession,
  useDictationSessionStore,
} from "./dictationSessionStore";
import {
  useDictationDelivery,
  useDictationKeybindings,
  useDictationEnvironments,
} from "./useDictationSession";

/** The composer's microphone: starts a recording in this window. */
export const DictationStartButton = memo(function DictationStartButton() {
  const recording = useDictationSessionStore((state) => state.session !== null);
  const label = recording ? "A dictation session is already active" : "Start voice dictation";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-disabled={recording}
            aria-label={label}
            className={cn(
              "rounded-full text-secondary-label transition-colors",
              recording && "cursor-default opacity-45",
            )}
            onClick={() => {
              if (!recording) void startDictation();
            }}
          >
            <MicIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
});

// HACK: the shipped strip still reads a Symmetria Shell session, so this recording is dressed
// up as one, as the prototype did. Remove once phase 8 moves DictationStripBanner out of
// `symmetria/` and gives it a Mesura session type.
const BANNER_TARGET = {
  kind: "thread",
  environmentId: EnvironmentId.make("mesura-dictation"),
  threadId: ThreadId.make("mesura-dictation"),
} as const;

function toBannerSession(session: DictationRecordingSession): SymmetriaDictationSession {
  return {
    protocolVersion: { major: 1, minor: 5 },
    sessionId: SymmetriaDictationSessionId.make(session.sessionId),
    target: BANNER_TARGET,
    source: "mesura",
    phase: session.runningSince === null ? "paused" : "recording",
    mode: session.mode,
    projectName: null,
    startedAt: new Date(session.startedAt).toISOString(),
    elapsedMs: Math.floor(recordedDictationMs(session, session.sampledAt)),
    audioLevel: session.level,
    graceRemainingMs: null,
    presentation: { mesuraOwnsPresentation: true, leaseExpiresAt: null },
  };
}

const STRIP_CONTROLS: Partial<Record<string, () => void>> = {
  pause: toggleDictationPause,
  resume: toggleDictationPause,
  restart: () => void restartDictation(),
  cancel: cancelDictation,
  stop: () => void stopDictation(),
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/** The shipped strip, shown while this window records. It goes away when recording stops. */
export const DictationRecordingStrip = memo(function DictationRecordingStrip() {
  const session = useDictationSessionStore((state) => state.session);
  if (!session) return null;
  return (
    <DictationStripBanner
      session={toBannerSession(session)}
      reducedMotion={prefersReducedMotion()}
      onControl={(action) => STRIP_CONTROLS[action]?.()}
      onChangeMode={cycleDictationMode}
      onDismiss={() => undefined}
    />
  );
});

function DictationEnvironmentDelivery({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  useDictationDelivery(environmentId);
  return null;
}

/**
 * Mounted once for the whole app: places this client's transcripts into whichever draft holds
 * their marker, on screen or not, and listens for the dictation keys.
 */
export function DictationJobDelivery() {
  useDictationKeybindings();
  return useDictationEnvironments().map((environmentId) => (
    <DictationEnvironmentDelivery key={environmentId} environmentId={environmentId} />
  ));
}
