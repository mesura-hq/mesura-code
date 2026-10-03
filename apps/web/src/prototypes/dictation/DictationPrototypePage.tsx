/**
 * Prototype of the Mesura-owned dictation design (STT redesign). Everything is
 * simulated in the browser: no audio, no server job, no agent turn. It exists
 * to judge the interaction before the plan is written.
 */
import { CopyIcon, MonitorIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import "./dictationPrototype.css";
import { ElsewhereScene } from "./DesktopWidget";
import {
  cancelRecording,
  finishRecording,
  jobsForThread,
  restartRecording,
  setActiveThread,
  setDeliveryMode,
  setScene,
  setSimulation,
  startRecording,
  togglePause,
  usePrototypeStore,
  type DeliveryMode,
  type PrototypeThread,
} from "./prototypeStore";
import { PrototypeComposer } from "./PrototypeComposer";

/** Shell's session binds: they select the mode, they do not stop the recording. */
const MODE_KEYS: Record<string, DeliveryMode> = {
  KeyI: "inject",
  Enter: "submit",
  NumpadEnter: "submit",
  KeyS: "clipboard",
};

/**
 * The page-wide keys stand in for Hyprland binds, so they also work in the
 * simulated "another app" scene. Capture phase, so Alt+Enter never reaches the
 * editor as a newline.
 */
function useDictationKeys() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = usePrototypeStore.getState();
      if (event.ctrlKey && event.shiftKey && event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        if (state.recording) finishRecording();
        else startRecording();
        return;
      }
      if (event.code === "Escape" && state.scene === "elsewhere") {
        setScene("mesura");
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const mode = MODE_KEYS[event.code];
      if (mode) {
        if (!setDeliveryMode(mode)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!state.recording) return;
      const action =
        event.code === "Space"
          ? togglePause
          : event.code === "KeyR"
            ? restartRecording
            : event.code === "KeyX"
              ? cancelRecording
              : null;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}

function ThreadBadges(props: { thread: PrototypeThread }) {
  const jobs = usePrototypeStore((state) => state.jobs);
  const threadJobs = jobsForThread(jobs, props.thread.id);
  const transcribing = threadJobs.filter((job) => job.status === "transcribing").length;
  const failed = threadJobs.some((job) => job.status === "failed");
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px]">
      {transcribing > 0 ? (
        <span className="rounded bg-primary/15 px-1 text-primary">{transcribing}</span>
      ) : null}
      {props.thread.sendWhenReady ? <span className="text-primary">will send</span> : null}
      {failed ? <span className="text-destructive-foreground">failed</span> : null}
    </span>
  );
}

function ThreadList(props: { compact: boolean }) {
  const threads = usePrototypeStore((state) => state.threads);
  const activeThreadId = usePrototypeStore((state) => state.activeThreadId);
  return (
    <nav className={cn(props.compact ? "flex gap-1 overflow-x-auto" : "flex flex-col gap-0.5")}>
      {threads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setActiveThread(thread.id)}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
            props.compact && "shrink-0 border border-border/50",
            thread.id === activeThreadId
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60",
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {thread.title}
            {props.compact ? null : (
              <span className="block truncate text-[11px] text-muted-foreground/70">
                {thread.project}
              </span>
            )}
          </span>
          <ThreadBadges thread={thread} />
        </button>
      ))}
    </nav>
  );
}

function SavedTranscriptions() {
  const saved = usePrototypeStore((state) => state.saved);
  if (saved.length === 0) return null;
  return (
    <div className="mt-4 border-t border-border/50 pt-3">
      <div className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground uppercase">
        Transcriptions
      </div>
      {saved.map((entry) => (
        <div
          key={entry.id}
          className="group flex items-start gap-1 rounded-md px-2.5 py-1 text-[12px]"
        >
          <span className="line-clamp-2 min-w-0 flex-1 text-secondary-label">{entry.text}</span>
          <button
            type="button"
            aria-label="Copy"
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            onClick={() => void navigator.clipboard?.writeText(entry.text)}
          >
            <CopyIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function MessageText(props: { text: string }) {
  if (!props.text.startsWith("[voiced] ")) return <>{props.text}</>;
  return (
    <>
      <span className="font-mono text-[11px] text-primary">[voiced]</span>
      {props.text.slice("[voiced]".length)}
    </>
  );
}

function Timeline() {
  const thread = usePrototypeStore((state) =>
    state.threads.find((entry) => entry.id === state.activeThreadId),
  );
  if (!thread) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      {thread.messages.map((message) =>
        message.role === "user" ? (
          <div
            key={message.id}
            className="ml-auto max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-[14px]"
          >
            <MessageText text={message.text} />
          </div>
        ) : (
          <div key={message.id} className="max-w-[85%] text-[14px] text-secondary-label">
            {message.text}
          </div>
        ),
      )}
    </div>
  );
}

const DEFAULT_MODE_OPTIONS: ReadonlyArray<{ mode: DeliveryMode; label: string }> = [
  { mode: "submit", label: "Send" },
  { mode: "inject", label: "Insert" },
  { mode: "clipboard", label: "Save" },
];

function SimulationMenu() {
  const speed = usePrototypeStore((state) => state.speed);
  const defaultMode = usePrototypeStore((state) => state.defaultMode);
  const failNext = usePrototypeStore((state) => state.failNext);
  const option = (active: boolean) =>
    cn(
      "rounded-md px-2 py-1 text-xs",
      active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent",
    );
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
        <SlidersHorizontalIcon className="size-3.5" /> Simulation
      </summary>
      <div className="absolute right-0 z-40 mt-1 flex w-64 flex-col gap-3 rounded-xl border border-border bg-popover p-3 shadow-lg">
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">Transcription speed</div>
          <div className="flex gap-1">
            {(["fast", "realistic", "slow"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={option(speed === value)}
                onClick={() => setSimulation({ speed: value })}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">A new recording starts in</div>
          <div className="flex gap-1">
            {DEFAULT_MODE_OPTIONS.map((entry) => (
              <button
                key={entry.mode}
                type="button"
                className={option(defaultMode === entry.mode)}
                onClick={() => setSimulation({ defaultMode: entry.mode })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={option(failNext)}
          onClick={() => setSimulation({ failNext: !failNext })}
        >
          {failNext ? "The next transcription fails ✓" : "Make the next transcription fail"}
        </button>
        <button type="button" className={option(false)} onClick={() => window.location.reload()}>
          Reset the prototype
        </button>
      </div>
    </details>
  );
}

const SCENARIOS = [
  "Record first, place later: press Ctrl+Shift+Space (or the mic) and talk. Move the caret where the text belongs, then stop with the square or Ctrl+Shift+Space. The marker drops at the caret on stop.",
  "Modes, as in Shell: Alt+S save, Alt+I insert, Alt+Enter send. They only pick the mode (the mode button shows it); they keep working while the text transcribes.",
  "Chain: while a marker transcribes, move the caret, or change thread, and record again.",
  "Send from afar: record in send mode, stop, and switch thread at once. The sidebar shows the job, and a toast says when it sent.",
  "Edit while it transcribes: type around the marker. Delete a marker: its text goes to Transcriptions, never lost. Press Enter with a marker pending: the draft waits for it.",
  "Another app focused (desktop): Focus another app, then Ctrl+Shift+Space to record and to stop. The text lands in the last thread you had open.",
  "Failure: Simulation → Make the next transcription fail, then use Retry on the marker.",
];

function ScenarioGuide() {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <div className="mx-auto mt-3 w-full max-w-3xl px-4">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          What to try
        </button>
      </div>
    );
  }
  return (
    <div className="mx-auto mt-4 w-full max-w-3xl px-4">
      <div className="rounded-xl border border-border/60 bg-card/50 p-3 text-[12px] text-secondary-label">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-medium text-foreground">What to try</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            Hide
          </button>
        </div>
        <ol className="list-decimal space-y-1 pl-4">
          {SCENARIOS.map((scenario) => (
            <li key={scenario}>{scenario}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = usePrototypeStore((state) => state.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex flex-col items-center gap-1.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            "rounded-full border border-border bg-popover px-3 py-1.5 text-xs shadow-lg",
            toast.tone === "success" && "text-emerald-400",
            toast.tone === "error" && "text-destructive-foreground",
          )}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}

export function DictationPrototypePage() {
  useDictationKeys();
  const scene = usePrototypeStore((state) => state.scene);
  const activeTitle = usePrototypeStore(
    (state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.title,
  );

  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border/50 p-2 md:flex">
        <div className="px-2.5 pt-1 pb-3 text-[13px] font-medium">
          Mesura Code <span className="text-muted-foreground">· dictation prototype</span>
        </div>
        <ThreadList compact={false} />
        <SavedTranscriptions />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{activeTitle}</span>
          <button
            type="button"
            className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent md:flex"
            onClick={() => {
              (document.activeElement as HTMLElement | null)?.blur();
              setScene("elsewhere");
            }}
          >
            <MonitorIcon className="size-3.5" /> Focus another app
          </button>
          <SimulationMenu />
        </header>
        <div className="border-b border-border/50 p-2 md:hidden">
          <ThreadList compact />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ScenarioGuide />
          <Timeline />
          <div className="md:hidden">
            <div className="px-4">
              <SavedTranscriptions />
            </div>
          </div>
        </div>
        <div className="px-3 pb-3">
          <PrototypeComposer />
        </div>
      </main>
      <Toasts />
      {scene === "elsewhere" ? <ElsewhereScene /> : null}
    </div>
  );
}
