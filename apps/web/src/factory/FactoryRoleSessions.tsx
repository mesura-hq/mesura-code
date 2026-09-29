import type { ScopedThreadRef } from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";
import { memo } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { factoryTurnFilesMarkdown, type FactoryRoleSessionRow } from "./factoryRunView.logic";
import { factoryEventClock } from "./factoryTones";

const FactoryRoleSession = memo(function FactoryRoleSession({
  row,
  threadRef,
  cwd,
}: {
  row: FactoryRoleSessionRow;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  return (
    <li className="rounded-lg border border-border/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-foreground capitalize">{row.role}</span>
        <Badge variant={row.status === "running" ? "info" : "secondary"}>
          {row.status === "running" ? <CircleDotIcon aria-hidden className="size-3" /> : null}
          {row.status}
        </Badge>
        <span className="text-muted-foreground">
          {row.harness} · {row.model}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {row.turnCount} {row.turnCount === 1 ? "turn" : "turns"}
        </span>
        {row.cost === null ? null : (
          <span className="text-muted-foreground tabular-nums">{row.cost}</span>
        )}
      </div>
      <p className="mt-1 truncate font-mono text-[.65rem] text-muted-foreground/80">
        session {row.sessionId ?? "not reported yet"}
      </p>
      {row.status === "running" ? (
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
          <span>{row.toolCalls ?? 0} tool calls</span>
          {row.lastTool === null ? null : <span>last {row.lastTool}</span>}
          {row.lastActivityAt === null ? null : (
            <span>
              active{" "}
              <time dateTime={row.lastActivityAt}>{factoryEventClock(row.lastActivityAt)}</time>
            </span>
          )}
        </p>
      ) : null}
      <div className="mt-1 text-xs">
        <ChatMarkdown text={factoryTurnFilesMarkdown(row.turns)} cwd={cwd} threadRef={threadRef} />
      </div>
    </li>
  );
});

/** One row per role session of the selected phase, each listing its turns' files. */
export const FactoryRoleSessions = memo(function FactoryRoleSessions({
  rows,
  threadRef,
  cwd,
}: {
  rows: ReadonlyArray<FactoryRoleSessionRow>;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No role has been dispatched yet.</p>;
  }
  return (
    <ol className="space-y-2" aria-label="Role sessions">
      {rows.map((row) => (
        <FactoryRoleSession key={row.key} row={row} threadRef={threadRef} cwd={cwd} />
      ))}
    </ol>
  );
});
