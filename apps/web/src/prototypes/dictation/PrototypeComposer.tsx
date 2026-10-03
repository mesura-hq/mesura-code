import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { ArrowUpIcon, MicIcon, SendIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { ComposerBanner } from "~/components/chat/ComposerBanner";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { cn } from "~/lib/utils";
import { DictationSlotNode } from "./DictationSlotNode";
import { Hint } from "./Hint";
import { registerDraftEditor } from "./draftEditors";
import {
  cancelSendWhenReady,
  finishRecording,
  jobsForThread,
  requestSend,
  startRecording,
  usePrototypeStore,
} from "./prototypeStore";
import { RecordingStrip } from "./RecordingStrip";

function DraftEditorBridge(props: { threadId: string }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerDraftEditor(props.threadId, editor), [editor, props.threadId]);
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event || event.shiftKey || event.altKey) return false;
          event.preventDefault();
          requestSend(props.threadId);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, props.threadId],
  );
  return null;
}

/** Stays mounted while hidden, so a transcript can land in an off-screen draft. */
function ThreadDraftEditor(props: { threadId: string; hidden: boolean }) {
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: `dictation-prototype-${props.threadId}`,
      nodes: [DictationSlotNode],
      theme: { paragraph: "m-0" },
      onError: (error) => {
        throw error;
      },
    }),
    [props.threadId],
  );
  return (
    <div className={cn("relative", props.hidden && "hidden")}>
      <LexicalComposer initialConfig={initialConfig}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Message"
              className="max-h-60 min-h-17.5 overflow-y-auto px-4 pt-3.5 pb-1 text-[14px] leading-relaxed whitespace-pre-wrap text-foreground outline-none"
            />
          }
          placeholder={
            <div className="pointer-events-none absolute top-3.5 left-4 text-[14px] text-placeholder">
              Ask anything… or press Ctrl+Shift+Space to dictate
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <DraftEditorBridge threadId={props.threadId} />
      </LexicalComposer>
    </div>
  );
}

function SendWhenReadyBanner(props: { threadId: string; pending: number }) {
  return (
    <ComposerBanner.Attachment className="pointer-events-auto relative z-0">
      <ComposerBanner.Root variant="info">
        <div className="flex min-h-8 items-center gap-2 px-2 text-xs">
          <SendIcon className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-secondary-label">
            {props.pending === 1
              ? "Sends when the transcription lands. You can keep editing."
              : `Sends when ${props.pending} transcriptions land. You can keep editing.`}
          </span>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => cancelSendWhenReady(props.threadId)}
          >
            Don't send
          </button>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

export function PrototypeComposer() {
  const threads = usePrototypeStore((state) => state.threads);
  const activeThreadId = usePrototypeStore((state) => state.activeThreadId);
  const recording = usePrototypeStore((state) => state.recording);
  const jobs = usePrototypeStore((state) => state.jobs);
  const activeThread = threads.find((thread) => thread.id === activeThreadId)!;
  const pendingHere = jobsForThread(jobs, activeThreadId).filter((job) => job.mode !== "save");
  const recordingHere = recording?.threadId === activeThreadId;

  return (
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <div className="mx-auto w-full min-w-0 max-w-3xl" data-chat-composer-form="true">
          <ComposerBanner.Dock>
            <ComposerBanner.Column>
              {activeThread.sendWhenReady && pendingHere.length > 0 ? (
                <SendWhenReadyBanner threadId={activeThreadId} pending={pendingHere.length} />
              ) : null}
              <RecordingStrip displayedThreadId={activeThreadId} />
            </ComposerBanner.Column>
          </ComposerBanner.Dock>
          <div className="relative">
            <ComposerSurface.Main>
              <div data-chat-composer-surface="true" className="rounded-[20px]">
                {threads.map((thread) => (
                  <ThreadDraftEditor
                    key={thread.id}
                    threadId={thread.id}
                    hidden={thread.id !== activeThreadId}
                  />
                ))}
                <div className="flex items-center gap-2 px-2.5 pb-2.5">
                  <span className="min-w-0 flex-1 truncate pl-1.5 text-[11px] text-muted-foreground">
                    {pendingHere.length > 0
                      ? `${pendingHere.length} dictation${pendingHere.length === 1 ? "" : "s"} pending in this draft`
                      : "Prototype · simulated transcription"}
                  </span>
                  <Hint
                    label={
                      recording
                        ? "Stop (Ctrl+Shift+Space)"
                        : "Dictate at the caret (Ctrl+Shift+Space)"
                    }
                  >
                    <button
                      type="button"
                      aria-label={recordingHere ? "Stop recording" : "Start dictation"}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() =>
                        recording ? finishRecording() : startRecording(activeThreadId)
                      }
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full",
                        recording
                          ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {recording ? (
                        <SquareIcon className="size-3.5" />
                      ) : (
                        <MicIcon className="size-4" />
                      )}
                    </button>
                  </Hint>
                  <button
                    type="button"
                    aria-label="Send"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => requestSend(activeThreadId)}
                    className="flex size-8 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover"
                  >
                    <ArrowUpIcon className="size-4" />
                  </button>
                </div>
              </div>
            </ComposerSurface.Main>
          </div>
        </div>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}
