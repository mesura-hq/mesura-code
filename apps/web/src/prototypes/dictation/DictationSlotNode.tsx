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
import { RotateCcwIcon, XIcon } from "lucide-react";
import type { ReactElement } from "react";

import { MaterialDictationModeIcon } from "~/symmetria/MaterialDictationModeIcon";
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

const WAVE_BARS = [0, 1, 2, 3, 4, 5] as const;

function DictationSlotChip(props: { jobId: string }) {
  const job = usePrototypeStore((state) => state.jobs[props.jobId]);
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

  return (
    <span
      contentEditable={false}
      data-slot-status={job.status}
      className="dictation-slot mx-0.5 inline-flex h-[1.4em] items-center gap-1 rounded-sm px-0.5 align-middle text-[11px] leading-none text-primary select-none"
    >
      <span className="dictation-slot-caret inline-block h-[1.5em] w-[2px] rounded-full bg-primary" />
      <span
        aria-label="Transcribing"
        className="dictation-slot-wave inline-flex h-[1em] items-center gap-[2px]"
      >
        {WAVE_BARS.map((bar) => (
          <span key={bar} className="block h-full w-[2px] rounded-full bg-primary/80" />
        ))}
      </span>
      <MaterialDictationModeIcon mode={job.mode} className="size-3 opacity-70" />
    </span>
  );
}
