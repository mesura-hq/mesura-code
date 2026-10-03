/**
 * What Hyprland would show while another app has focus: a small pinned,
 * unfocusable Electron window at the bottom of the screen. The spike on
 * 2026-10-03 proved the real window works with four window rules (float, pin,
 * no_initial_focus, no_focus); here it is drawn over a fake terminal.
 */
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { CenterOutWaveform } from "~/symmetria/CenterOutWaveform";
import { recordedMsAt, setScene, usePrototypeStore } from "./prototypeStore";
import { formatClock } from "./RecordingStrip";

const FLASH_VISIBLE_MS = 1_800;

function useFreshFlash() {
  const flash = usePrototypeStore((state) => state.flash);
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!flash) return;
    const remaining = flash.at + FLASH_VISIBLE_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => rerender((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [flash]);
  return flash && Date.now() - flash.at < FLASH_VISIBLE_MS ? flash : null;
}

function DesktopWidget() {
  const recording = usePrototypeStore((state) => state.recording);
  const threads = usePrototypeStore((state) => state.threads);
  const jobs = usePrototypeStore((state) => state.jobs);
  const flash = useFreshFlash();
  const transcribing = Object.values(jobs).filter((job) => job.status === "transcribing");
  const failed = Object.values(jobs).filter((job) => job.status === "failed");
  const titleOf = (threadId: string) => threads.find((thread) => thread.id === threadId)?.title;

  let body: React.ReactNode = null;
  if (recording) {
    const paused = recording.runningSince === null;
    body = (
      <>
        <span
          className={cn(
            "size-2 rounded-full",
            paused ? "bg-zinc-500" : "dictation-rec-dot bg-red-500",
          )}
        />
        <span className="font-mono text-xs tabular-nums text-zinc-300">
          {formatClock(recordedMsAt(recording, Date.now()))}
        </span>
        <div className="w-28">
          <CenterOutWaveform
            sessionId={recording.jobId}
            phase={paused ? "paused" : "recording"}
            audioLevel={recording.level}
            active
            reducedMotion={false}
          />
        </div>
        <span className="max-w-32 truncate text-xs text-zinc-400">
          → {titleOf(recording.threadId)}
        </span>
        {transcribing.length > 0 ? (
          <span className="text-[11px] text-sky-300">+{transcribing.length} transcribing</span>
        ) : null}
      </>
    );
  } else if (failed.length > 0) {
    body = (
      <span className="text-xs text-red-300">
        Transcription failed in {titleOf(failed[0]!.threadId)}. Open Mesura to retry.
      </span>
    );
  } else if (transcribing.length > 0) {
    body = (
      <span className="dictation-widget-transcribing text-xs text-sky-300">
        Transcribing{" "}
        {transcribing.length > 1
          ? `${transcribing.length} recordings`
          : `→ ${titleOf(transcribing[0]!.threadId)}`}
      </span>
    );
  } else if (flash) {
    body = (
      <span className="flex items-center gap-1.5 text-xs text-emerald-400">
        <CheckIcon className="size-3.5" />
        {flash.text}
      </span>
    );
  }
  if (!body) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center font-sans">
      <div className="flex h-11 items-center gap-2.5 rounded-full border border-white/10 bg-zinc-900/90 px-4 shadow-xl backdrop-blur">
        {body}
      </div>
    </div>
  );
}

const FAKE_TERMINAL_LINES = [
  "~/repos/symetria-shell on main",
  "❯ nvim modules/agentbar/AgentChip.qml",
  "",
  "  1 import QtQuick",
  "  2 import Quickshell",
  "  3 ",
  "  4 Item {",
  "  5     id: root",
  "  6     property var agent",
];

/** A stand-in for any other focused app. Keys still reach the prototype, like Hyprland binds would. */
export function ElsewhereScene() {
  const recordingTarget = usePrototypeStore(
    (state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.title,
  );
  return (
    <div className="fixed inset-0 z-50 bg-[#1b1b1f] font-mono text-[13px] text-zinc-300">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-2 font-sans text-xs text-zinc-400">
        <span>
          Simulated: another app has focus. Ctrl+Shift+Space records into <b>{recordingTarget}</b>.
          Alt+I, Alt+Enter and Alt+S finish.
        </span>
        <button
          type="button"
          className="rounded-md border border-white/10 px-2 py-1 text-zinc-200 hover:bg-white/5"
          onClick={() => setScene("mesura")}
        >
          Back to Mesura (Esc)
        </button>
      </div>
      <pre className="p-4 leading-6">{FAKE_TERMINAL_LINES.join("\n")}</pre>
      <DesktopWidget />
    </div>
  );
}
