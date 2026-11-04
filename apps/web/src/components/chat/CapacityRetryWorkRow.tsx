import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { CircleAlertIcon, CircleCheckIcon, CircleMinusIcon } from "lucide-react";
import { type ReactNode, use, useRef, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { type CapacityRetryView, capacityRetryView, formatCountdown } from "./capacityRetry.logic";
import { TimelineRowCtx, type TimelineWorkEntry } from "./timelineRowContext";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { WorkLogRow } from "./WorkLog";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

interface CapacityRetryWorkRowProps {
  readonly item: ErrorTurnItem;
  readonly view: CapacityRetryView;
  readonly environmentId: EnvironmentId;
  readonly timestampFormat: TimestampFormat;
  readonly createdAt: string;
  readonly visibility: string | undefined;
}

/**
 * Mesura: a Codex capacity retry in the work log and in the live line, with its
 * countdown, Retry now and schedule. Null for any other entry.
 */
export function CapacityRetryWorkEntry({ workEntry }: { readonly workEntry: TimelineWorkEntry }) {
  const ctx = use(TimelineRowCtx);
  const item = workEntry.projectedItem?.item;
  const view = item?.type === "error" ? capacityRetryView(item) : null;
  if (item?.type !== "error" || view === null) return null;
  const props: CapacityRetryWorkRowProps = {
    item,
    view,
    environmentId: ctx.activeThreadEnvironmentId,
    timestampFormat: ctx.timestampFormat,
    createdAt: workEntry.createdAt,
    visibility: workEntry.projectedItem?.visibility,
  };
  return view.nextAttemptAtMs === null ? (
    <SettledCapacityRetryRow {...props} />
  ) : (
    <WaitingCapacityRetryRow {...props} nextAttemptAtMs={view.nextAttemptAtMs} />
  );
}

export function isCapacityRetryWorkEntry(workEntry: TimelineWorkEntry): boolean {
  const item = workEntry.projectedItem?.item;
  return item?.type === "error" && capacityRetryView(item) !== null;
}

function SettledCapacityRetryRow(props: CapacityRetryWorkRowProps) {
  const { item, view } = props;
  const Icon =
    item.status === "completed"
      ? CircleCheckIcon
      : item.status === "failed"
        ? CircleAlertIcon
        : CircleMinusIcon;
  return (
    <CapacityRetryRowFrame
      {...props}
      icon={
        <Icon
          className={cn(
            "size-4",
            item.status === "completed" && "text-success",
            item.status === "failed" && "text-destructive",
            item.status !== "completed" && item.status !== "failed" && "text-muted-foreground",
          )}
        />
      }
      detail={view.detail}
    />
  );
}

function WaitingCapacityRetryRow(props: CapacityRetryWorkRowProps & { nextAttemptAtMs: number }) {
  const { item, view, nextAttemptAtMs } = props;
  const nowMs = useNowSecond();
  const retryNow = useAtomCommand(serverEnvironment.retryProviderNow, {
    label: "retry provider now",
    reportFailure: false,
    reportDefect: false,
  });
  const canRetryNow = useAtomValue(
    serverEnvironment.retryProviderNow.permissionAtom(props.environmentId),
  );
  // The attempt Retry now was pressed for; the next attempt's wait brings the button back.
  const [requestedAttempt, setRequestedAttempt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const progress =
    view.maxAttempts === null ? `${view.attempt}` : `${view.attempt}/${view.maxAttempts}`;
  const remainingMs = nextAttemptAtMs - nowMs;
  const starting = remainingMs <= 0 || requestedAttempt === view.attempt;
  const target =
    item.providerThreadId === null || item.providerTurnId === null
      ? null
      : {
          threadId: item.threadId,
          providerThreadId: item.providerThreadId,
          providerTurnId: item.providerTurnId,
        };

  const onRetryNow = async () => {
    if (inFlight.current || target === null) return;
    inFlight.current = true;
    setError(null);
    setRequestedAttempt(view.attempt);
    const result = await retryNow({ environmentId: props.environmentId, input: target }).finally(
      () => {
        inFlight.current = false;
      },
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setRequestedAttempt(null);
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not retry now.");
    }
  };

  return (
    <CapacityRetryRowFrame
      {...props}
      icon={<CircleAlertIcon className="size-4 text-warning" />}
      detail={
        starting ? (
          `Retry ${progress} starting…`
        ) : (
          <>
            Retry <span className="font-mono tabular-nums">{progress}</span> at{" "}
            <span className="font-mono tabular-nums">
              {formatUpcomingTimestamp(
                new Date(nextAttemptAtMs).toISOString(),
                props.timestampFormat,
                nowMs,
              )}
            </span>{" "}
            · in <span className="font-mono tabular-nums">{formatCountdown(remainingMs)}</span>
          </>
        )
      }
      action={
        canRetryNow && !starting && target !== null ? (
          <Button size="micro" variant="outline" onClick={() => void onRetryNow()}>
            Retry now
          </Button>
        ) : null
      }
      error={error}
    />
  );
}

function CapacityRetryRowFrame(
  props: CapacityRetryWorkRowProps & {
    readonly icon: ReactNode;
    readonly detail: ReactNode;
    readonly action?: ReactNode;
    readonly error?: string | null;
  },
) {
  const { item, view } = props;
  return (
    <WorkLogRow
      data-v2-item-type="error"
      data-v2-item-visibility={props.visibility}
      data-capacity-retry={item.status}
      wrapLabel
      icon={props.icon}
      label={
        <span className="text-sm">
          <span className="font-medium text-foreground/90">{view.label}</span>
          {props.detail === null ? null : (
            <span className="text-muted-foreground"> · {props.detail}</span>
          )}
        </span>
      }
      trailing={
        <TimelineRowTimestamp
          createdAt={props.createdAt}
          timestampFormat={props.timestampFormat}
          alwaysVisible
        />
      }
    >
      {view.steps.length > 0 || props.action || props.error ? (
        <div className="ms-7 flex flex-wrap items-center gap-x-2 gap-y-1 pb-1">
          {view.steps.length > 0 ? (
            <span className="flex flex-wrap items-center gap-0.5" aria-hidden>
              {view.steps.map((step, index) => (
                <span
                  // oxlint-disable-next-line react/no-array-index-key -- a fixed schedule; labels can repeat
                  key={index}
                  data-capacity-retry-step={step.state}
                  className={cn(
                    "rounded border border-transparent px-1 font-mono text-3xs text-muted-foreground/50",
                    step.state === "done" && "line-through",
                    step.state === "current" && "border-warning/45 text-warning",
                  )}
                >
                  {step.label}
                </span>
              ))}
            </span>
          ) : null}
          {props.action}
          {props.error ? (
            <span role="alert" className="text-xs text-destructive">
              {props.error}
            </span>
          ) : null}
        </div>
      ) : null}
    </WorkLogRow>
  );
}
