import { describe, expect, it } from "vite-plus/test";

import { MonacoFileModelRegistry, RETAINED_PROJECT_LIMIT } from "./monacoFileModelRegistry.ts";

/**
 * Where a file's undo stack lives while nobody is looking at it.
 *
 * It lives in the Monaco model, and the panel that owns the model unmounts for
 * three ordinary things: opening Settings, switching to a thread in another
 * project, and the spinner shown while a file is read. The cache was already
 * hoisted once, from the surface to the panel, to survive the third. This is
 * the same move again, out of React entirely, because the first two are routes
 * and no component survives a route.
 *
 * What the registry has to get right is the lifetime: a project nobody is
 * looking at is kept, and kept bounded, and a project somebody *is* looking at
 * is never thrown away underneath them.
 */

interface FakeProject {
  readonly name: string;
  disposed: boolean;
  cleared: boolean;
}

const registryWithClock = () => {
  let now = 0;
  const created: FakeProject[] = [];
  const registry = new MonacoFileModelRegistry<FakeProject>({
    create: (key) => {
      const project = { name: key, disposed: false, cleared: false };
      created.push(project);
      return project;
    },
    dispose: (project) => {
      project.disposed = true;
      project.cleared = true;
    },
    now: () => (now += 1),
  });
  return { registry, created };
};

describe("MonacoFileModelRegistry", () => {
  it("gives the same project the same cache twice", () => {
    const { registry, created } = registryWithClock();
    const first = registry.acquire("env:/a");
    const second = registry.acquire("env:/a");
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
  });

  it("keeps a project after the last panel lets go of it", () => {
    // The whole point. A release is somebody navigating away, not somebody
    // saying they are finished with the file.
    const { registry } = registryWithClock();
    const project = registry.acquire("env:/a");
    registry.release("env:/a");
    expect(project.disposed).toBe(false);
    expect(registry.acquire("env:/a")).toBe(project);
  });

  it("throws away the project released longest ago, once there are too many", () => {
    const { registry, created } = registryWithClock();
    for (let index = 0; index <= RETAINED_PROJECT_LIMIT; index += 1) {
      registry.acquire(`env:/project-${index}`);
      registry.release(`env:/project-${index}`);
    }
    // The first one released is the one nobody has wanted for longest.
    expect(created[0]?.disposed).toBe(true);
    expect(created[1]?.disposed).toBe(false);
    expect(created[RETAINED_PROJECT_LIMIT]?.disposed).toBe(false);
  });

  it("never throws away a project somebody is looking at", () => {
    // A panel is open on the first project the whole time. Evicting it would
    // dispose the models under a live editor, which is a blank panel and a
    // lost undo stack for the file the developer is actually in.
    const { registry, created } = registryWithClock();
    registry.acquire("env:/held");
    for (let index = 0; index < RETAINED_PROJECT_LIMIT + 3; index += 1) {
      registry.acquire(`env:/project-${index}`);
      registry.release(`env:/project-${index}`);
    }
    expect(created[0]?.disposed).toBe(false);
  });

  it("counts panels rather than assuming one", () => {
    // Two panels on one project is reachable: the files surface and a second
    // view of the same worktree. The first to unmount must not take the cache
    // out from under the second.
    const { registry } = registryWithClock();
    const project = registry.acquire("env:/a");
    registry.acquire("env:/a");
    registry.release("env:/a");

    for (let index = 0; index < RETAINED_PROJECT_LIMIT + 2; index += 1) {
      registry.acquire(`env:/other-${index}`);
      registry.release(`env:/other-${index}`);
    }
    expect(project.disposed).toBe(false);
  });

  it("ignores a release for a project it does not hold", () => {
    const { registry } = registryWithClock();
    expect(() => registry.release("env:/never-acquired")).not.toThrow();
  });

  it("builds a project again after it was evicted", () => {
    const { registry, created } = registryWithClock();
    registry.acquire("env:/a");
    registry.release("env:/a");
    for (let index = 0; index < RETAINED_PROJECT_LIMIT; index += 1) {
      registry.acquire(`env:/project-${index}`);
      registry.release(`env:/project-${index}`);
    }
    expect(created[0]?.disposed).toBe(true);

    const rebuilt = registry.acquire("env:/a");
    expect(rebuilt).not.toBe(created[0]);
    expect(rebuilt.disposed).toBe(false);
  });
});
