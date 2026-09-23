import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
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
  /**
   * How each environment is named under the thread's project, for callers that
   * show threads from more than one. Omit it and the row names no environment,
   * which is what a single-environment picker wants.
   */
  readonly environmentLabelById?: ReadonlyMap<EnvironmentId, string>;
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
  const environmentLabelById = input?.environmentLabelById;

  // Keyed by environment as well as project id: two environments can both hold
  // a project of the same id, and the favicon is the project's own.
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
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
              project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
              projectTitle={projectTitle ?? null}
              environmentLabel={
                environmentLabelById
                  ? (environmentLabelById.get(thread.environmentId) ?? "Remote")
                  : null
              }
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
      environmentLabelById,
      navigate,
      projectByKey,
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
