/**
 * The shadow caret: an inline Lexical node that marks where a pending
 * transcription will land. It moves with the text as the user edits around
 * it, and the transcript replaces it when the job completes.
 *
 * In the real composer this would follow `ComposerContextReferenceNode`: an
 * inline decorator that serializes to a token in the persisted prompt string,
 * so a draft that is not mounted can still be filled by replacing the token.
 */
import { DecoratorNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { RotateCcwIcon, SendIcon, XIcon } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "~/lib/utils";
import { discardJob, retryJob, usePrototypeStore } from "./prototypeStore";

type SerializedDictationSlotNode = Spread<{ jobId: string }, SerializedLexicalNode>;

export class DictationSlotNode extends DecoratorNode<ReactElement> {
  __jobId: string;

  static override getType(): "prototype-dictation-slot" {
    return "prototype-dictation-slot";
  }

  static override clone(node: DictationSlotNode): DictationSlotNode {
    return new DictationSlotNode(node.__jobId, node.__key);
  }

  static override importJSON(serialized: SerializedDictationSlotNode): DictationSlotNode {
    return new DictationSlotNode(serialized.jobId).updateFromJSON(serialized);
  }

  constructor(jobId: string, key?: NodeKey) {
    super(key);
    this.__jobId = jobId;
  }

  override exportJSON(): SerializedDictationSlotNode {
    return {
      ...super.exportJSON(),
      jobId: this.getLatest().__jobId,
      type: "prototype-dictation-slot",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-block align-middle";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  /** Empty, so a pending slot never leaks into the sent text. */
  override getTextContent(): string {
    return "";
  }

  override isInline(): true {
    return true;
  }

  getJobId(): string {
    return this.getLatest().__jobId;
  }

  override decorate(): ReactElement {
    return <DictationSlotChip jobId={this.__jobId} />;
  }
}

function DictationSlotChip(props: { jobId: string }) {
  const job = usePrototypeStore((state) => state.jobs[props.jobId]);
  const paused = usePrototypeStore(
    (state) => state.recording?.jobId === props.jobId && state.recording.runningSince === null,
  );
  // A slot whose job is gone renders nothing; delivery removes it right after.
  if (!job) return <span />;

  if (job.status === "failed") {
    return (
      <span
        contentEditable={false}
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-destructive/40 align-middle bg-destructive/10 px-1.5 py-px align-baseline text-[11px] text-destructive-foreground"
      >
        transcription failed
        <button
          type="button"
          className="rounded p-0.5 hover:bg-destructive/20"
          aria-label="Retry transcription"
          onClick={() => retryJob(job.id)}
        >
          <RotateCcwIcon className="size-3" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 hover:bg-destructive/20"
          aria-label="Discard recording"
          onClick={() => discardJob(job.id)}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    );
  }

  const recording = job.status === "recording";
  return (
    <span
      contentEditable={false}
      data-slot-status={paused ? "paused" : job.status}
      className={cn(
        "dictation-slot mx-0.5 inline-flex h-[1.4em] items-center gap-1 rounded-sm px-0.5 align-middle text-[11px] leading-none select-none",
        recording ? "text-red-400" : "text-primary",
      )}
    >
      <span
        className={cn(
          "dictation-slot-caret inline-block h-[1.5em] w-[2px] rounded-full",
          recording ? "bg-red-400" : "bg-primary",
        )}
      />
      <span className="dictation-slot-label opacity-70">
        {recording ? (paused ? "paused" : "listening") : "transcribing"}
      </span>
      {job.mode === "submit" ? <SendIcon className="size-2.5 opacity-70" /> : null}
    </span>
  );
}
