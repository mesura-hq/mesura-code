import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { useEnvironments } from "~/state/environments";
import { readThreadShell, useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { toastManager } from "../ui/toast";
import { resolveArchivedResult } from "./agentSearchPopup.logic";

const THREAD_ROUTE = /^\/([^/?#]+)\/([^/?#]+)$/u;

/**
 * Mesura: a search result can be an archived thread (ADR-010), which the thread
 * route treats as missing. A click on such a link inside the search
 * conversation unarchives the thread on the host that holds it, waits for its
 * active shell, and only then opens it, as the old picker did.
 */
export function ArchivedResultLinks({ children }: { children: ReactNode }) {
  const { environments } = useEnvironments();
  const { snapshots } = useArchivedThreadSnapshots(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const { unarchiveThread } = useThreadActions();
  const [opening, setOpening] = useState<ScopedThreadRef | null>(null);

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    const route = anchor ? THREAD_ROUTE.exec(anchor.getAttribute("href") ?? "") : null;
    if (!route) return;
    const linked = scopeThreadRef(
      EnvironmentId.make(decodeURIComponent(route[1]!)),
      ThreadId.make(decodeURIComponent(route[2]!)),
    );
    const active = readThreadShell(linked);
    if (active !== null && active.archivedAt === null) return;
    event.preventDefault();
    const target = resolveArchivedResult(
      linked.threadId,
      linked.environmentId,
      snapshots.map(({ environmentId, snapshot }) => ({
        environmentId,
        threadIds: snapshot.threads.map((thread) => thread.id),
      })),
    );
    if (target === null) {
      toastManager.add({ type: "error", title: "This thread is no longer available" });
      return;
    }
    void unarchiveThread(target).then((result) => {
      if (result._tag === "Success") setOpening(target);
      else toastManager.add({ type: "error", title: "Could not unarchive this thread" });
    });
  };

  return (
    <div className="contents" onClickCapture={onClickCapture}>
      {children}
      {opening ? (
        <OpenWhenActive key={`${opening.environmentId}:${opening.threadId}`} thread={opening} />
      ) : null}
    </div>
  );
}

/**
 * Opens the unarchived thread once its active shell arrives: the unarchive
 * command settles before the shell stream delivers it, and the route would
 * otherwise read it as missing. Navigating closes the popup, which unmounts this.
 */
function OpenWhenActive({ thread }: { thread: ScopedThreadRef }) {
  const shell = useThreadShell(thread);
  const navigate = useNavigate();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || shell === null || shell.archivedAt !== null) return;
    opened.current = true;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(thread) });
  }, [navigate, shell, thread]);
  return null;
}
