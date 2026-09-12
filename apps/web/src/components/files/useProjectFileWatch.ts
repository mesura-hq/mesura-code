import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectFileWatchEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
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
 * Re-reads the open file when it changes on disk.
 *
 * Subscribing keeps a server watcher alive for exactly as long as this hook is
 * mounted. Whether a given event should cause a read is decided purely, in
 * `projectFileWatchRefresh`, because the interesting cases are sequences: the
 * baseline that must not read, a change during a local save that must wait, and
 * a reconnect whose baseline is genuinely new information.
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

  useEffect(() => {
    // A different file is a different subscription, so nothing carried over
    // from the previous one is true of this one.
    if (lastResourceKeyRef.current !== resourceKey) {
      lastResourceKeyRef.current = resourceKey;
      stateRef.current = initialProjectFileWatchState;
      lastEventRef.current = null;
    }

    // This effect also runs when only `enabled` changed. Offering the same
    // event again would re-handle it, so an event is offered once and `null`
    // stands for "nothing new arrived, re-check whether a deferred change may
    // be applied now".
    //
    // ASSUMPTION, unverified by any test because this project's web tests have
    // no DOM to mount a hook in: the atom hands back the same object reference
    // across renders until a genuinely new stream element arrives. Every other
    // subscription consumer in this app relies on the same thing. If it ever
    // stopped holding, two distinct events arriving in one render would collapse
    // into one and a change would be missed.
    const isNewEvent = event !== null && event !== lastEventRef.current;
    if (isNewEvent) lastEventRef.current = event;

    const action = nextProjectFileWatchAction(stateRef.current, isNewEvent ? event : null, enabled);
    stateRef.current = action.state;
    if (action.refresh) refresh();
  }, [enabled, event, refresh, resourceKey]);
}
