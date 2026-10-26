/**
 * Pure: turns a series of read models into frames (a snapshot for a new peer, then deltas).
 * This module numbers the frames, not upstream's `snapshotSequence`, which advances on every event
 * this projection drops and would make consumers resnapshot on almost every delta.
 * A dropped thread or a renderer reload (new generation) has no delta form, so it emits a SNAPSHOT.
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
 * An IPC payload is `unknown` on arrival; a malformed push publishes nothing, not a half-built
 * world. Deliberately shallow: it checks only the generation and the keys the feed indexes on, and
 * `projectReadModel` builds every other field by name.
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
