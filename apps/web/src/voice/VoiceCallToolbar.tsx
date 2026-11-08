import { Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { VoiceCallLayout } from "./VoiceCallTranscript";

const LAYOUTS: ReadonlyArray<readonly [VoiceCallLayout, string]> = [
  ["call", "Call"],
  ["split", "Split"],
  ["work", "Work"],
];

// Touch targets reach 44px on narrow screens, where the call is driven by touch.
const TOUCH_TARGET = "max-sm:h-11 max-sm:w-11 max-sm:min-w-11 max-sm:px-0";

/**
 * The only control surface of a live call: one row with the view, mute and hang up. It exists
 * only while a call connects or runs; ending, errors and history live outside it.
 */
export function VoiceCallToolbar({
  connecting,
  status,
  layout,
  onLayoutChange,
  muted,
  onToggleMute,
  onHangup,
  playbackBlocked,
  onResumeAudio,
  followUps,
  onClearFollowUps,
  agentRequestWaiting,
}: {
  connecting: boolean;
  status: string;
  layout: VoiceCallLayout;
  onLayoutChange: (layout: VoiceCallLayout) => void;
  muted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
  playbackBlocked: boolean;
  onResumeAudio: () => void;
  followUps: number;
  onClearFollowUps: () => void;
  agentRequestWaiting: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Voice call"
      className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5 sm:gap-2 sm:px-3"
    >
      <div role="group" aria-label="Call view" className="flex shrink-0 items-center gap-0.5">
        {LAYOUTS.map(([value, label]) => (
          <Button
            key={value}
            size="xs"
            variant={layout === value ? "secondary" : "ghost-muted"}
            aria-pressed={layout === value}
            className={TOUCH_TARGET}
            onClick={() => onLayoutChange(value)}
          >
            {label}
            {value === "work" && agentRequestWaiting && layout !== "work" ? (
              <span
                className="size-1.5 rounded-full bg-warning"
                aria-label="Agent request waiting"
              />
            ) : null}
          </Button>
        ))}
      </div>
      <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {status}
      </span>
      {followUps > 0 ? (
        <Button
          size="xs"
          variant="ghost"
          className={cn("shrink-0", TOUCH_TARGET)}
          aria-label={`Clear ${followUps} waiting follow-up${followUps === 1 ? "" : "s"}`}
          onClick={onClearFollowUps}
        >
          {followUps}
          <span className="hidden sm:inline">waiting</span>
        </Button>
      ) : null}
      {playbackBlocked ? (
        <Button
          size="xs"
          variant="outline"
          className={cn("shrink-0", TOUCH_TARGET)}
          aria-label="Resume audio"
          onClick={onResumeAudio}
        >
          <Volume2 aria-hidden /> <span className="hidden sm:inline">Resume audio</span>
        </Button>
      ) : null}
      {connecting ? null : (
        <Button
          size="icon-sm"
          variant="ghost"
          className={cn("shrink-0", "max-sm:size-11")}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          onClick={onToggleMute}
        >
          {muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
        </Button>
      )}
      <Button
        size="sm"
        variant="destructive-outline"
        className={cn("shrink-0", TOUCH_TARGET)}
        aria-label={connecting ? "Cancel" : "Hang up"}
        onClick={onHangup}
      >
        <PhoneOff aria-hidden />
        <span className="hidden sm:inline">{connecting ? "Cancel" : "Hang up"}</span>
      </Button>
    </div>
  );
}
