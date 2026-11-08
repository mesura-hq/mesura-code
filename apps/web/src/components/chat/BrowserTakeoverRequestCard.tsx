import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CheckIcon, GlobeIcon, MinusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { setActivePreviewTab } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

type BrowserTakeoverRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "browser_takeover_request" }
>;

const OUTCOME_LABELS = {
  done: "The operator finished in the browser",
  declined: "The operator could not do it",
  cancelled: "Request ended",
} as const;

const USER_FACING_FAILURE_TAGS = new Set(["BrowserTakeoverError", "EnvironmentAuthorizationError"]);

/** Only known server errors show their message; anything else gets the generic copy. */
function takeoverFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return failure.message;
  }
  return "Could not answer the takeover request.";
}

/**
 * Mesura: inline card for a server browser tab an agent asked the operator to
 * take over. Taking control of the tab and releasing it answers the card too.
 */
export function BrowserTakeoverRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: BrowserTakeoverRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  if (item.takeoverStatus !== "pending" || props.visibility !== "local") {
    const Icon =
      item.takeoverStatus === "pending"
        ? GlobeIcon
        : item.takeoverStatus === "done"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          item.takeoverStatus === "pending"
            ? "Waiting for the operator in the original thread"
            : OUTCOME_LABELS[item.takeoverStatus]
        }
      />
    );
  }
  return <PendingBrowserTakeoverRequest {...props} />;
}

function PendingBrowserTakeoverRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: BrowserTakeoverRequestItem;
}) {
  const { item, threadRef } = props;
  const answer = useAtomCommand(serverEnvironment.answerBrowserTakeoverRequest, {
    label: "answer browser takeover request",
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerBrowserTakeoverRequest.permissionAtom(props.environmentId),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two quick clicks can both send before a render.
  const inFlight = useRef(false);

  const send = async (reply: "done" | "declined") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, answer: reply },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(takeoverFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">The agent needs you in the browser</p>
        <p className="text-sm text-muted-foreground">{item.reason}</p>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={threadRef === null}
          onClick={() => {
            if (threadRef === null) return;
            setActivePreviewTab(threadRef, item.tabId);
            // The panel shows its own surface's tab, so selecting the tab alone shows nothing.
            useRightPanelStore.getState().openBrowser(threadRef, item.tabId);
          }}
        >
          Open tab
        </Button>
        {canAnswer ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={submitting}
              onClick={() => void send("declined")}
            >
              Cannot do it
            </Button>
            <Button type="button" size="xs" disabled={submitting} onClick={() => void send("done")}>
              Done
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
