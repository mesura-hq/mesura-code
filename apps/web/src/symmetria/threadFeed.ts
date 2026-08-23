/**
 * Builds what the renderer forwards to the main process for publication.
 *
 * Pure, and deliberately the only decidable part of this direction — the hook
 * beside it is glue. The same split as `sttDelivery.ts` next door, and for the
 * same reason: everything worth a test lives here.
 *
 * ## The allowlist starts here, not at the wire
 *
 * The main process projects again before publishing, and that second pass is
 * the authority. This one still narrows, because what crosses the IPC boundary
 * is what a crash dump or a devtools trace can show: forwarding whole threads
 * would put the transcript into a message that has no reason to carry it.
 *
 * Two vocabularies meet here. The renderer holds a project as `{ id, title }`
 * and a thread shell as the fork spells it; the main process wants
 * `ProjectableReadModel`. This module names every field it copies, so a field
 * upstream adds cannot ride along by accident.
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

export type FeedPayload = {
  readonly generation: string;
  readonly readModel: {
    readonly projects: readonly FeedProject[];
    readonly threads: readonly FeedThread[];
  };
};

/**
 * Narrows the renderer's own values into the payload.
 *
 * A deleted thread is dropped rather than forwarded. The wire has a
 * `deletedAt` field and the contract deliberately has no removal member, so a
 * consumer is meant to read a thread's own departure — but the bar draws a
 * pill per live thread, and forwarding tombstones would make every consumer
 * filter them again. Dropping here is the same decision the sidebar already
 * makes on screen.
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

/**
 * Whether the payload says anything new.
 *
 * The renderer's state changes far more often than this projection does —
 * most of what moves is transcript the projection drops — so without this the
 * IPC channel would carry a byte-identical message per streaming token. The
 * main process compares again before emitting a delta; this comparison exists
 * to keep the message off the channel at all, which is the cheaper place to
 * stop it.
 */
export function hasFeedChanged(previous: string | null, next: FeedPayload): boolean {
  return previous !== JSON.stringify(next.readModel);
}
