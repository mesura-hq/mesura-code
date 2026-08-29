import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";

import {
  buildThreadActionItems,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../components/CommandPalette.logic";
import { ThreadCommandSubtitle } from "../components/ThreadCommandSubtitle";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
} from "../components/ThreadStatusIndicators";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import type { Thread } from "../types";
import { useClientSettings } from "./useSettings";

/**
 * Every thread in every environment, as command-palette rows, newest first.
 *
 * The command palette and the thread search picker need the same row: the same
 * status badges, the same project subtitle, the same navigation. Building it in
 * one place is what stops a badge added to one of them from being missing on
 * the other.
 *
 * The rows come out in the sidebar's thread sort order, so a caller that ranks
 * them by relevance has to break ties by input position to keep recency
 * underneath.
 */
export function useThreadCommandItems(input?: {
  /** Marks the row for the thread the user is already reading. */
  readonly activeThreadId?: Thread["id"] | undefined;
  /** Message hits from the server, keyed by `threadSearchMatchKey`. */
  readonly contentMatchByKey?: ReadonlyMap<string, EnvironmentThreadSearchMatch>;
  /** What the snippet highlights, which is the word the server searched for. */
  readonly contentQuery?: string;
}): CommandPaletteActionItem[] {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const clientSettings = useClientSettings();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);

  const activeThreadId = input?.activeThreadId;
  const contentMatchByKey = input?.contentMatchByKey;
  const contentQuery = input?.contentQuery ?? "";

  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.workspaceRoot] as const)),
    [projects],
  );
  const projectFaviconPathById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.faviconPath ?? null] as const)),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const providerEntryByEnvironmentAndInstanceId = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const environmentProviders =
        environment.serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? providers : []);
      for (const entry of deriveProviderInstanceEntries(environmentProviders)) {
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
      }
    }
    return map;
  }, [environments, primaryEnvironmentId, providers]);

  return useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: clientSettings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        renderDescription: (thread, { projectTitle }) => {
          const modelInstanceId =
            thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
          const providerEntry =
            providerEntryByEnvironmentAndInstanceId.get(
              `${thread.environmentId}:${modelInstanceId}`,
            ) ?? null;
          return (
            <ThreadCommandSubtitle
              environmentId={thread.environmentId}
              projectCwd={projectCwdById.get(thread.projectId) ?? null}
              projectFaviconPath={projectFaviconPathById.get(thread.projectId) ?? null}
              projectTitle={projectTitle ?? null}
              branch={thread.branch}
              worktreePath={thread.worktreePath}
              isCurrent={thread.id === activeThreadId}
              driverKind={providerEntry?.driverKind ?? null}
              providerDisplayName={
                thread.session?.providerName ?? providerEntry?.displayName ?? modelInstanceId
              }
            />
          );
        },
        getContentMatch: (thread) => {
          const match = contentMatchByKey?.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          );
          return match && (match.source === "user" || match.source === "assistant")
            ? { source: match.source, snippet: match.snippet, query: contentQuery }
            : undefined;
        },
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [
      activeThreadId,
      clientSettings.sidebarThreadSortOrder,
      contentMatchByKey,
      contentQuery,
      navigate,
      projectCwdById,
      projectFaviconPathById,
      projectTitleById,
      providerEntryByEnvironmentAndInstanceId,
      threads,
    ],
  );
}

/** The environments a thread search can reach: everything currently connected. */
export function useConnectedEnvironmentIds() {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
}
