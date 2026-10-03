import { SendIcon } from "lucide-react";
import { memo } from "react";

import { ComposerBanner } from "~/components/chat/ComposerBanner";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { disarmSendWhenReady, useSendWhenReadyArmed } from "./sendWhenReady";

/** Says an armed draft or answer goes by itself once its transcriptions land, with a way out. */
export function SendWhenReadyNotice(props: {
  readonly pendingCount: number;
  readonly onCancel: () => void;
}) {
  return (
    <ComposerBanner.Root variant="info">
      <div className="flex min-h-8 items-center gap-2 px-2 text-xs">
        <SendIcon className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-secondary-label">
          {props.pendingCount === 1
            ? "Sends when the transcription lands. You can keep editing."
            : `Sends when ${props.pendingCount} transcriptions land. You can keep editing.`}
        </span>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onCancel}
        >
          Don't send
        </button>
      </div>
    </ComposerBanner.Root>
  );
}

/** The composer's banner for an armed draft. */
export const SendWhenReadyBanner = memo(function SendWhenReadyBanner(props: {
  readonly target: ComposerThreadTarget;
  readonly pendingCount: number;
}) {
  const armed = useSendWhenReadyArmed(props.target);
  if (!armed || props.pendingCount === 0) return null;
  return (
    <ComposerBanner.Attachment className="pointer-events-auto relative z-0">
      <SendWhenReadyNotice
        pendingCount={props.pendingCount}
        onCancel={() => disarmSendWhenReady(props.target)}
      />
    </ComposerBanner.Attachment>
  );
});
