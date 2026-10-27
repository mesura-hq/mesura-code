/**
 * The allowlist starts here: the main process projects again and is the authority, but
 * what crosses IPC can show up in a crash dump or devtools trace, so this module copies
 * named fields only. A field upstream adds cannot carry the transcript along by accident.
 */

/** The renderer's project, narrowed to what is forwarded. */
export type FeedProject = {
  readonly id: string;
  readonly title: string;
};

/** The renderer's thread, narrowed to what is forwarded. */
export type FeedThread = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: string;
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly snoozedUntil?: string | null | undefined;
  readonly pinnedAt?: string | null | undefined;
  // Optional, and that is the shell's shape rather than a convenience: the
  // renderer's lightweight thread does not carry a tombstone at all, because a
  // deleted thread simply stops being listed. Absent therefore means "not
  // deleted", which is what the filter below reads it as.
  readonly deletedAt?: string | null | undefined;
};

/** The parts of the v2 thread shell the feed reads (`EnvironmentThreadShell`). */
export interface FeedThreadShellSource {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestRun: {
    readonly runId: string;
    readonly status: string;
    readonly requestedAt: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly runtime: { readonly status: string; readonly activeRunId: string | null } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly snoozedUntil?: string | null | undefined;
  readonly pinnedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

/**
 * Maps the v2 thread shell onto the feed's wire shape, which keeps its v1
 * names (`latestTurn`, `session`) because Symmetria Shell's bar reads them.
 * A run is the v2 name for a turn; its status string passes through as the
 * turn state, and the runtime status as the session status.
 */
export function feedThreadFromShell(thread: FeedThreadShellSource): FeedThread {
  const run = thread.latestRun;
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn:
      run === null
        ? null
        : {
            turnId: run.runId,
            state: run.status,
            requestedAt: run.requestedAt ?? thread.updatedAt,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          },
    session:
      thread.runtime === null
        ? null
        : { status: thread.runtime.status, activeTurnId: thread.runtime.activeRunId },
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    deletedAt: thread.deletedAt ?? null,
  };
}

export type FeedPayload = {
  readonly generation: string;
  readonly readModel: {
    readonly projects: readonly FeedProject[];
    readonly threads: readonly FeedThread[];
  };
};

/**
 * Drops deleted threads although the wire has `deletedAt`: the bar draws one pill
 * per live thread, and forwarding tombstones would make every consumer filter them again.
 */
export function buildFeedPayload(input: {
  readonly generation: string;
  readonly projects: readonly FeedProject[];
  readonly threads: readonly FeedThread[];
}): FeedPayload {
  return {
    generation: input.generation,
    readModel: {
      projects: input.projects.map((project) => ({ id: project.id, title: project.title })),
      threads: input.threads
        .filter((thread) => (thread.deletedAt ?? null) === null)
        .map((thread) => ({
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestTurn: thread.latestTurn,
          session: thread.session,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          archivedAt: thread.archivedAt,
          settledAt: thread.settledAt,
          snoozedUntil: thread.snoozedUntil ?? null,
          pinnedAt: thread.pinnedAt ?? null,
          deletedAt: thread.deletedAt ?? null,
        })),
    },
  };
}

/** The read model as the change check compares it; computed once per push. */
export function feedReadModelKey(payload: FeedPayload): string {
  return JSON.stringify(payload.readModel);
}

/**
 * Keeps a byte-identical message per streaming token off the IPC channel.
 * The main process compares again before emitting a delta; stopping it here is cheaper.
 */
export function hasFeedChanged(previous: string | null, next: FeedPayload): boolean {
  return previous !== feedReadModelKey(next);
}
