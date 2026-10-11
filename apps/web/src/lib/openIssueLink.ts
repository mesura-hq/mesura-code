import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  issueRepositoryUrl,
  type EnvironmentId,
  type IssueReference,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  type ChangeRequestLink,
} from "@t3tools/shared/changeRequestUrl";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { issuesAvailability } from "../components/issues/issues.logic";
import { remarkPullRequestAutolinks } from "../components/pullRequest/pullRequestMarkdown.logic";
import { type IssuesPanelSelection, useRightPanelStore } from "../rightPanelStore";
import { useProjects, useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { issueReference } from "../state/issues";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { findProjectForChangeRequest } from "./openPullRequestLink";

/**
 * The repository and number behind a GitHub issue URL, or null for anything else. GitHub serves
 * pull requests under `/issues/` too, so this names a number, not a kind: only the server's
 * classification can say which surface opens it.
 */
export function parseIssueUrl(targetUrl: string): ChangeRequestLink | null {
  const candidate = pullRequestCandidateUrlFromReferenceAutolink(targetUrl);
  return candidate === null ? null : parseChangeRequestUrl(candidate);
}

/**
 * The project of the given environment whose recorded GitHub repository is exactly the link's.
 * Another environment holding the same repository, or another repository on the same host, is
 * never borrowed: the read runs on the thread's own server with that project's repository.
 */
export function findProjectForIssueLink(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  return findProjectForChangeRequest(
    projects.filter(
      (project) =>
        project.environmentId === environmentId &&
        project.repositoryIdentity?.provider === "github",
    ),
    link,
  );
}

/** Only a plain primary activation is followed in the app; any modifier keeps the link a link. */
export function shouldInterceptIssueLinkClick(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button">,
): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The project the Issues surface shows. A selection names its project on the thread's
 * environment; when that project is gone the answer is nothing rather than another repository.
 */
export function issuesSurfaceProject(input: {
  selection: IssuesPanelSelection | undefined;
  environmentId: EnvironmentId;
  projects: ReadonlyArray<EnvironmentProject>;
  activeProject: EnvironmentProject | null;
}): EnvironmentProject | null {
  if (input.selection === undefined) return input.activeProject;
  const { projectId } = input.selection;
  return (
    input.projects.find(
      (project) => project.environmentId === input.environmentId && project.id === projectId,
    ) ?? null
  );
}

/** Whether GitHub's answer names the clicked number of the clicked repository, as an issue or a PR. */
function answersLink(reference: IssueReference, link: ChangeRequestLink): boolean {
  const answered =
    reference.kind === "issue"
      ? parseIssueUrl(reference.url)
      : parseChangeRequestUrl(reference.url);
  return (
    answered !== null &&
    reference.number === link.number &&
    answered.number === link.number &&
    answered.host === link.host &&
    answered.repository === link.repository
  );
}

/**
 * The newest activation per thread, shared by every message of that thread: a click in one
 * message makes a slower answer for a click in another one stale. The owner is the message that
 * started it, so a message leaving the screen drops only an activation it still owns.
 */
const latestActivationByThread = new Map<string, { token: number; owner: object }>();
let nextActivationToken = 0;

/**
 * Follows an issue reference in a thread's messages into the Issues surface beside the thread,
 * or the pull-request surface when GitHub says the number is a pull request. The classification
 * is read once per click; nothing is read, opened or saved while a message renders.
 */
export function useOpenIssueReference(
  threadRef: ScopedThreadRef | undefined,
  handlers: {
    /** Opens a canonical pull-request URL in the app and says whether it did. */
    readonly openChangeRequest: (url: string) => boolean;
    /** Follows the original URL as the ordinary link it is. */
    readonly openFallback: (url: string) => Promise<void>;
  },
) {
  const projects = useProjects();
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  const resolve = useAtomQueryRunner(issueReference, {
    reportFailure: false,
    reportDefect: false,
  });
  const owner = useRef({});
  const threadKey = threadRef === undefined ? null : scopedThreadKey(threadRef);
  useEffect(
    () => () => {
      if (threadKey !== null && latestActivationByThread.get(threadKey)?.owner === owner.current) {
        latestActivationByThread.delete(threadKey);
      }
    },
    [threadKey],
  );
  // A stale capability from before a disconnect is not a yes: only a connected server that
  // advertises the resolver is sent the read.
  const canResolve =
    issuesAvailability(environment) === "available" &&
    environment?.serverConfig?.environment.capabilities.issueReferences === true;

  const targetOf = useCallback(
    (href: string) => {
      if (threadRef === undefined || !canResolve) return null;
      const link = parseIssueUrl(href);
      if (link === null) return null;
      const project = findProjectForIssueLink(projects, threadRef.environmentId, link);
      return project === undefined ? null : { link, project };
    },
    [canResolve, projects, threadRef],
  );

  const { openChangeRequest, openFallback } = handlers;
  const open = useCallback(
    (
      event: Pick<
        MouseEvent,
        "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button" | "preventDefault"
      > &
        Pick<MouseEvent, "stopPropagation">,
      href: string,
    ): boolean => {
      if (threadRef === undefined || threadKey === null || !shouldInterceptIssueLinkClick(event))
        return false;
      const target = targetOf(href);
      if (target === null) return false;
      event.preventDefault();
      event.stopPropagation();
      const token = (nextActivationToken += 1);
      latestActivationByThread.set(threadKey, { token, owner: owner.current });
      // Any panel choice the reader makes while GitHub answers — a file, a pull request, closing
      // the panel — is newer than this click; automatic panel updates do not count.
      const panelRevision = useRightPanelStore.getState().getUserActionRevision(threadRef);
      const { link, project } = target;
      void resolve({
        environmentId: threadRef.environmentId,
        input: { projectId: project.id, number: link.number },
      })
        .then(async (result) => {
          if (latestActivationByThread.get(threadKey)?.token !== token) return;
          latestActivationByThread.delete(threadKey);
          if (
            isAtomCommandInterrupted(result) ||
            useRightPanelStore.getState().getUserActionRevision(threadRef) !== panelRevision
          )
            return;
          if (result._tag === "Success" && answersLink(result.value, link)) {
            if (result.value.kind === "issue") {
              useRightPanelStore
                .getState()
                .openIssue(threadRef, { projectId: project.id, number: link.number });
              return;
            }
            if (openChangeRequest(result.value.url)) return;
          }
          // Unreadable, or an answer about something else: the reader still gets where the
          // link points, never a different repository's or number's surface.
          await openFallback(href);
        })
        .catch((error: unknown) => {
          console.error("[issue-reference] failed to open link", error);
        });
      return true;
    },
    [openChangeRequest, openFallback, resolve, targetOf, threadKey, threadRef],
  );

  return useMemo(() => ({ targetOf, open }), [open, targetOf]);
}

type RemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
const NO_REMARK_PLUGINS: RemarkPlugins = [];

/**
 * Remark plugins that turn `#123` in a thread's agent prose into a link to the thread project's
 * repository, or none when that repository is not known: the thread's own project decides, never
 * a title or a working directory. `enabled: false` returns none too, for a streaming message:
 * any extra plugin turns off incremental parsing, which keeps a long answer from reparsing its
 * finished code blocks.
 */
export function useIssueReferenceAutolinks(
  threadRef: ScopedThreadRef | null | undefined,
  enabled: boolean,
): RemarkPlugins {
  const shell = useThreadShell(threadRef ?? null);
  const projects = useProjects();
  const project =
    shell?.projectId == null || threadRef == null
      ? undefined
      : projects.find(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId && candidate.id === shell.projectId,
        );
  const repositoryUrl =
    project?.repositoryIdentity?.provider === "github"
      ? issueRepositoryUrl(project.repositoryIdentity)
      : null;
  return useMemo(
    () =>
      repositoryUrl === null || !enabled
        ? NO_REMARK_PLUGINS
        : [[remarkPullRequestAutolinks, { repositoryUrl, commits: false }]],
    [enabled, repositoryUrl],
  );
}
