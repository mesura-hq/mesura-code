import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  SharedAgentRamSummary,
  ThreadId,
  WorkloadSummary,
} from "@t3tools/contracts";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useWorkloadControl, useWorkloadQuery } from "../../state/workloads";
import { Button } from "../ui/button";
import {
  workloadControlAvailability,
  workloadControlInput,
  workloadControlNotice,
  workloadRamLabel,
} from "./workloadPresentation";

function WorkloadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: WorkloadSummary;
  readonly fresh: boolean;
  readonly observedAt: number;
  readonly threadId?: ThreadId;
}) {
  const { environmentId, row } = props;
  const control = useWorkloadControl(environmentId, row.recordId);
  const availability = workloadControlAvailability(row);
  const permitted = availability.operation === "start" ? control.canStart : control.canStop;
  const observedAfterControl = control.settledAt === null || props.observedAt > control.settledAt;
  const enabled =
    availability.available &&
    permitted &&
    props.fresh &&
    observedAfterControl &&
    control.pending === null;
  const input = workloadControlInput(row);
  const notice = control.result === null ? null : workloadControlNotice(control.result);
  const owner = row.association.state === "assigned" ? row.association.threadId : null;
  const threadRef = useMemo(
    () => (owner === null ? null : scopeThreadRef(environmentId, owner)),
    [environmentId, owner],
  );
  const openLink = useOpenLink(threadRef);
  const [linkError, setLinkError] = useState(false);
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-border/50 border-t py-3 first:border-t-0"
      data-workload-record={row.recordId}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="break-words text-xs font-medium">{row.name}</div>
          <p className="mt-1 font-mono text-3xs text-muted-foreground">
            {row.managerState === "running"
              ? "● Running"
              : row.managerState === "unknown"
                ? "State unavailable"
                : `○ ${row.managerState.charAt(0).toUpperCase()}${row.managerState.slice(1)}`}{" "}
            · {workloadRamLabel(row.ramBytes)}
          </p>
          <p className="mt-1 text-3xs text-muted-foreground">
            {owner === null
              ? "Unassigned"
              : props.threadId === owner
                ? "Assigned to this thread"
                : "Assigned thread"}{" "}
            · {row.binding} · {row.registration}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled}
          aria-label={`${availability.operation === "start" ? "Start" : "Stop"} ${row.name}`}
          onClick={() => {
            if (enabled && input !== null) void control.run(availability.operation, input);
          }}
        >
          {control.pending === "start"
            ? "Starting…"
            : control.pending === "stop"
              ? "Stopping…"
              : availability.operation === "start"
                ? "Start"
                : "Stop"}
        </Button>
      </div>
      {!availability.available ? (
        <p className="text-3xs text-muted-foreground">{availability.reason}</p>
      ) : !permitted ? (
        <p className="text-3xs text-muted-foreground">Control access unavailable on this host.</p>
      ) : !props.fresh || !observedAfterControl ? (
        <p className="text-3xs text-muted-foreground">
          Waiting for a current workload observation.
        </p>
      ) : null}
      {row.ports.length > 0 ? (
        <p className="font-mono text-3xs text-muted-foreground">Ports: {row.ports.join(", ")}</p>
      ) : null}
      {row.remoteUrl === null ? (
        <p className="text-3xs text-muted-foreground">No remote link available.</p>
      ) : (
        <div className="flex min-w-0 flex-col items-start">
          <Button
            variant="link"
            size="sm-multiline"
            aria-label={`Open ${row.name}`}
            onClick={(event) => {
              setLinkError(false);
              void openLink(row.remoteUrl!, { event }).catch(() => setLinkError(true));
            }}
          >
            <ExternalLinkIcon />
            Open preview
          </Button>
          <span className="max-w-full break-all font-mono text-3xs text-muted-foreground">
            {row.remoteUrl}
          </span>
        </div>
      )}
      {linkError ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          The link could not open.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          <strong>{notice.title}.</strong> {notice.detail}
        </p>
      ) : null}
      {control.accessUnavailable ? (
        <p role="status" className="text-xs text-muted-foreground">
          Control access unavailable on this host.
        </p>
      ) : null}
      {control.unknownOutcome ? (
        <p role="status" className="text-xs text-muted-foreground">
          Request outcome unknown. Refreshing the host. Select an action again only after its
          current state is available.
        </p>
      ) : null}
    </li>
  );
}

function SharedAgentRam(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: SharedAgentRamSummary;
  readonly fresh: boolean;
}) {
  const { summary } = props;
  return (
    <div className="mt-2 min-w-0" aria-label="Shared agent RAM">
      <p className="text-3xs font-medium text-muted-foreground">Shared agent RAM</p>
      <p className="mt-1 text-3xs text-muted-foreground">
        Anonymous memory of the shared runtime scope, including its resident processes. Per-thread
        agent RAM unavailable.
      </p>
      {summary.incomplete ? (
        <p role="status" className="mt-1 text-3xs text-muted-foreground">
          Shared agent RAM observations are incomplete.
        </p>
      ) : null}
      {summary.status === "unsupported" ? (
        <p className="mt-1 text-3xs text-muted-foreground">
          Shared agent RAM unsupported on this host.
        </p>
      ) : summary.groups.length === 0 ? (
        <p className="mt-1 text-3xs text-muted-foreground">
          {summary.status === "available" && props.fresh
            ? "No shared agent runtime groups."
            : "Shared agent RAM unavailable."}
        </p>
      ) : (
        <ul className="mt-1 space-y-2">
          {summary.groups.map((group) => (
            <li
              key={`${props.environmentId}:${group.groupId}`}
              data-shared-agent-group={group.groupId}
              className="min-w-0"
            >
              <p className="break-words text-xs">
                {group.driver} · {group.instanceId}
              </p>
              <p className="mt-1 font-mono text-3xs text-muted-foreground">
                {props.fresh && group.status === "available"
                  ? workloadRamLabel(group.anonymousBytes)
                  : group.status === "unsupported"
                    ? "RAM unsupported"
                    : "RAM unavailable"}{" "}
                · {group.attachedThreadCount} attached{" "}
                {group.attachedThreadCount === 1 ? "thread" : "threads"}
              </p>
              {group.status === "available" && props.fresh ? (
                <p className="mt-1 text-3xs text-muted-foreground">Sampled {group.sampledAt}</p>
              ) : group.reason !== null ? (
                <p className="mt-1 text-3xs text-muted-foreground">
                  {group.reason.replaceAll("_", " ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One list renderer owns thread and Hosts rows, including access and observation states. */
export function WorkloadList(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly visible: boolean;
}) {
  const query = useWorkloadQuery(
    props.environmentId,
    props.threadId === undefined ? {} : { threadId: props.threadId },
    props.visible,
  );
  if (!props.visible) return null;
  return (
    <section
      aria-label={props.threadId === undefined ? "Host workloads" : "Servers in this thread"}
      className="min-w-0"
      data-workload-list={props.environmentId}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {props.threadId === undefined ? "Workloads" : "Servers in this thread"}
        </h3>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh workloads"
          disabled={!query.canRead || (!query.active && !query.accessDenied)}
          onClick={query.refresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <p className="mt-1 text-3xs text-muted-foreground">Per-thread agent RAM unavailable.</p>
      {!query.canRead || query.accessDenied ? (
        <p className="py-2 text-xs text-muted-foreground">
          Workload access unavailable on this host. Diagnostics access is required.
        </p>
      ) : query.error !== null ? (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          Workload observation unavailable. Refresh to try again.
        </p>
      ) : query.data === null ? (
        <p className="py-2 text-xs text-muted-foreground">Waiting for workloads…</p>
      ) : (
        <>
          <SharedAgentRam
            environmentId={props.environmentId}
            summary={query.data.sharedAgentRam}
            fresh={query.fresh}
          />
          {!query.fresh ? (
            <p role="status" className="py-1 text-3xs text-muted-foreground">
              Last observation · current workload state unavailable.
            </p>
          ) : null}
          {query.data.incomplete ? (
            <p role="status" className="py-1 text-3xs text-muted-foreground">
              Workload observations are incomplete.
            </p>
          ) : null}
          {query.data.registryState !== "available" ? (
            <p className="py-2 text-xs text-muted-foreground">
              {query.data.registryState === "absent"
                ? "No workload registry on this host."
                : query.data.registryState === "unsupported"
                  ? "Workloads are unsupported on this host."
                  : "Workload registry state unavailable."}
            </p>
          ) : query.data.workloads.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              No registered workloads{props.threadId === undefined ? "." : " for this thread."}
            </p>
          ) : (
            <ul className="min-w-0">
              {query.data.workloads.map((row) => (
                <WorkloadRow
                  key={row.recordId}
                  environmentId={props.environmentId}
                  row={row}
                  fresh={query.fresh}
                  observedAt={query.dataUpdatedAt}
                  {...(props.threadId === undefined ? {} : { threadId: props.threadId })}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
