/**
 * Turns a series of read models into the ordered stream a consumer reads.
 *
 * Pure and synchronous: no clock, no IO, no sockets. It holds the current
 * projected world and answers two questions — what a peer connecting NOW should
 * be handed, and what changed since the last push.
 *
 * ## Who numbers, and why it is not upstream
 *
 * ⚠ **This publisher owns the sequence, and that reverses what the previous
 * phase did.** The contract borrows its framing from upstream and says
 * `revision` is `OrchestrationReadModel.snapshotSequence` — "the position in
 * the event sequence that a snapshot reflects" — and that deltas number the
 * same sequence.
 *
 * That cannot hold here, and the reason is measurable rather than a matter of
 * taste: `projector.ts:203` sets `snapshotSequence` from `event.sequence`, so
 * it advances on EVERY orchestration event, the great majority of which are
 * transcript and activity events this projection drops. A delta numbered with
 * it would jump by tens, `applySymmetriaStreamDelta` would read a gap, and the
 * consumer would resnapshot on almost every update — the exact cost the gap
 * mechanism exists to make rare.
 *
 * So the numbering is this module's: one increment per emitted frame, and the
 * snapshot's revision is the last position emitted. That satisfies the rule a
 * consumer actually depends on — the first delta it may apply is `revision + 1`
 * — and gives up only the coincidence of sharing upstream's numbers, which no
 * consumer can observe.
 *
 * ## What cannot be expressed, and what is done instead
 *
 * The contract has no removal member, deliberately: a thread that goes away
 * says so in its own summary through `archivedAt` and `deletedAt`. But a read
 * model can simply stop listing a thread, and there is no delta for that. The
 * same is true of a renderer reload, whose new state has no relationship to the
 * old one.
 *
 * Both are discontinuities, and both are answered the same way: emit a whole
 * SNAPSHOT rather than a delta. A stream opens with a snapshot, so a consumer
 * already knows what to do with one; continuing the delta sequence across
 * either boundary would be the silent gap the framing forbids.
 */
import { projectReadModel, type ProjectableReadModel } from "./threadProjection.ts";

type WireSnapshot = ReturnType<typeof projectReadModel>;
type WireThread = WireSnapshot["threads"][number];
type WireProject = WireSnapshot["projects"][number];

/** One line to put on the wire, with the position it occupies. */
export type FeedFrame = {
  readonly sequence: number;
  readonly line: string;
};

export type Feed = {
  /**
   * Takes the latest read model and returns the frames to broadcast.
   *
   * `generation` identifies the renderer that produced it. A change of
   * generation is a discontinuity, not an update.
   */
  readonly accept: (
    generation: string,
    readModel: ProjectableReadModel,
  ) => ReadonlyArray<FeedFrame>;
  /** What a peer connecting now is handed. */
  readonly snapshot: () => WireSnapshot;
};

const byId = <T>(items: ReadonlyArray<T>, id: (item: T) => string): Map<string, T> =>
  new Map(items.map((item) => [id(item), item]));

export function createFeed(): Feed {
  let revision = 0;
  let generation: string | null = null;
  let threads: ReadonlyArray<WireThread> = [];
  let projects: ReadonlyArray<WireProject> = [];

  const currentSnapshot = (): WireSnapshot => ({
    ...projectReadModel({ projects: [], threads: [] }, revision),
    threads,
    projects,
  });

  const snapshotFrame = (): FeedFrame => {
    revision += 1;
    return { sequence: revision, line: JSON.stringify(currentSnapshot()) };
  };

  const deltaFrame = (change: unknown): FeedFrame => {
    revision += 1;
    return {
      sequence: revision,
      // `protocolVersion` is deliberately absent. The contract makes it an
      // optional key on a delta precisely so the hot path need not repeat what
      // the opening snapshot already settled.
      line: JSON.stringify({ type: "delta", sequence: revision, change }),
    };
  };

  return {
    snapshot: currentSnapshot,

    accept: (nextGeneration, readModel) => {
      const projected = projectReadModel(readModel, revision);
      const nextThreads = projected.threads;
      const nextProjects = projected.projects;

      const heldThreads = byId(threads, (thread) => thread.threadId);
      const heldProjects = byId(projects, (project) => project.projectId);

      // A discontinuity: a different renderer, or an entity that stopped being
      // listed. Neither is expressible as a delta — see the module note.
      const vanished =
        nextThreads.length < threads.length ||
        nextProjects.length < projects.length ||
        threads.some((thread) => !nextThreads.some((next) => next.threadId === thread.threadId)) ||
        projects.some(
          (project) => !nextProjects.some((next) => next.projectId === project.projectId),
        );

      if (generation !== nextGeneration || vanished) {
        generation = nextGeneration;
        threads = nextThreads;
        projects = nextProjects;
        return [snapshotFrame()];
      }

      const frames: FeedFrame[] = [];

      // Compared by serialisation rather than by field. The projection is a
      // small closed shape with no cycles and a stable key order, so this is
      // exact — and it is the comparison that matters, because what the
      // consumer receives is exactly these bytes.
      for (const next of nextThreads) {
        const held = heldThreads.get(next.threadId);
        if (held !== undefined && JSON.stringify(held) === JSON.stringify(next)) continue;
        frames.push(deltaFrame({ entity: "thread", thread: next }));
      }
      for (const next of nextProjects) {
        const held = heldProjects.get(next.projectId);
        if (held !== undefined && JSON.stringify(held) === JSON.stringify(next)) continue;
        frames.push(deltaFrame({ entity: "project", project: next }));
      }

      threads = nextThreads;
      projects = nextProjects;
      return frames;
    },
  };
}

/**
 * Reads what the renderer sent, refusing anything it cannot use.
 *
 * The renderer is our own code, but this is a process boundary and an IPC
 * payload is `unknown` on arrival. Refusing beats trusting: a malformed push
 * should publish nothing, not publish a half-built world.
 *
 * Deliberately shallow. It checks the shape the feed indexes on — a generation
 * string, and arrays whose entries carry the identifiers used as keys — and
 * lets `projectReadModel` handle the rest, which it already does by building
 * every field by name.
 */
export function parseFeedPush(
  raw: unknown,
): { readonly generation: string; readonly readModel: ProjectableReadModel } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const push = raw as Record<string, unknown>;
  const generation = push["generation"];
  const readModel = push["readModel"];
  if (typeof generation !== "string" || generation.length === 0) return null;
  if (typeof readModel !== "object" || readModel === null) return null;

  const candidate = readModel as Record<string, unknown>;
  const projects = candidate["projects"];
  const threads = candidate["threads"];
  if (!Array.isArray(projects) || !Array.isArray(threads)) return null;

  // Both keys the feed indexes on AND the one every row is rendered by. A row
  // with no title has nothing to draw and no business on the wire; checking it
  // here is also what keeps a malformed push from reaching the projection at
  // all, though the projection is total on its own account.
  const hasStrings = (items: ReadonlyArray<unknown>, keys: ReadonlyArray<string>): boolean =>
    items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        keys.every((key) => typeof (item as Record<string, unknown>)[key] === "string"),
    );
  if (!hasStrings(projects, ["id", "title"])) return null;
  if (!hasStrings(threads, ["id", "title"])) return null;

  return { generation, readModel: readModel as ProjectableReadModel };
}
