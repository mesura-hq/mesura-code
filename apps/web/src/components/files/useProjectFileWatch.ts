import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectFileWatchEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { projectFileWatch } from "~/state/projectFileWatch";
import {
  initialProjectFileWatchState,
  nextProjectFileWatchAction,
  type ProjectFileWatchState,
} from "./projectFileWatchRefresh";

const EMPTY_PROJECT_FILE_WATCH_ATOM = Atom.make(
  AsyncResult.initial<ProjectFileWatchEvent, never>(false),
).pipe(Atom.withLabel("project-file-watch:empty"));

/**
 * Re-reads the open file when it changes on disk. Subscribing keeps a server watcher alive while
 * this hook is mounted; `projectFileWatchRefresh` decides purely which events cause a read.
 */
export function useProjectFileWatch(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly enabled: boolean;
  readonly refresh: () => void;
}): void {
  const { environmentId, cwd, relativePath, enabled, refresh } = input;

  const atom =
    relativePath === null
      ? EMPTY_PROJECT_FILE_WATCH_ATOM
      : projectFileWatch({ environmentId, input: { cwd, relativePath } });
  const result = useAtomValue(atom);
  const event = Option.getOrNull(AsyncResult.value(result)) as ProjectFileWatchEvent | null;

  // Same shape as the `useWorkspaceMutationRefresh` key beside this hook in the
  // panel, so the two refresh paths identify a resource identically.
  const resourceKey = `file:${environmentId}:${cwd}:${relativePath ?? ""}`;
  const stateRef = useRef<ProjectFileWatchState>(initialProjectFileWatchState);
  const lastResourceKeyRef = useRef<string>(resourceKey);
  const lastEventRef = useRef<ProjectFileWatchEvent | null>(null);
  /**
   * The last revision handled for each path, kept across subscriptions: a returned-to file's new
   * baseline is the only report of changes made while it was in the background.
   */
  const seenRevisionsRef = useRef(new Map<string, string>());

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: feeds watch-stream events from the external subscription into the refresh decision
  useEffect(() => {
    // A different file is a different subscription, so nothing carried over
    // from the previous one is true of this one.
    if (lastResourceKeyRef.current !== resourceKey) {
      lastResourceKeyRef.current = resourceKey;
      stateRef.current = initialProjectFileWatchState;
      lastEventRef.current = null;
    }

    // This effect also runs when only `enabled` changed, so an event is offered once and `null`
    // means "re-check whether a deferred change may apply now". ASSUMPTION (untested): the atom
    // keeps the same event reference until a new stream element arrives, as every other
    // subscription consumer here relies on; otherwise two events in one render collapse into one.
    const isNewEvent = event !== null && event !== lastEventRef.current;
    if (isNewEvent) lastEventRef.current = event;

    const action = nextProjectFileWatchAction(
      stateRef.current,
      isNewEvent ? event : null,
      enabled,
      seenRevisionsRef.current.get(resourceKey) ?? null,
    );
    stateRef.current = action.state;
    if (action.state.handledRevision !== null) {
      seenRevisionsRef.current.set(resourceKey, action.state.handledRevision);
    }
    if (action.refresh) refresh();
  }, [enabled, event, refresh, resourceKey]);
}
