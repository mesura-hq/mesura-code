/**
 * Counts which components rendered in each React commit, by name, the way the
 * React DevTools see it: through `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which
 * `react-dom` reads once, when it loads.
 *
 * Install it from `vi.hoisted`, before anything imports `react-dom`:
 *
 * ```ts
 * const commits = await vi.hoisted(async () =>
 *   (await import("./test/reactCommitCounter")).installReactCommitCounter(),
 * );
 * ```
 *
 * It has no runtime imports, so loading it there loads nothing of React's.
 *
 * A fiber rendered in a commit when its current object changed since the
 * previous commit — React swaps a fiber with its alternate when it renders it,
 * and a subtree that bailed out keeps its objects — and its function ran
 * (`PerformedWork`). The walk covers every fiber of the root on every commit,
 * so it is only for tests with one root.
 */

/** React's `PerformedWork` fiber flag. */
const PERFORMED_WORK = 1;
/** Function, class, forwardRef, memo and simple memo components. */
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

interface Fiber {
  readonly tag: number;
  readonly flags: number;
  readonly type: unknown;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly return: Fiber | null;
}

export interface RenderedComponent {
  readonly name: string;
  /** The names of the components above it, nearest first. */
  readonly owners: ReadonlyArray<string>;
}

function componentName(fiber: Fiber): string | null {
  const type = fiber.type as
    | ((...args: never[]) => unknown)
    | {
        displayName?: string;
        render?: { displayName?: string; name?: string };
        type?: { displayName?: string; name?: string };
      }
    | null;
  if (type === null || type === undefined) return null;
  if (typeof type === "function") {
    return (type as { displayName?: string }).displayName ?? (type.name || null);
  }
  if (typeof type !== "object") return null;
  return (
    type.displayName ??
    type.render?.displayName ??
    type.render?.name ??
    type.type?.displayName ??
    type.type?.name ??
    null
  );
}

function ownersOf(fiber: Fiber): string[] {
  const owners: string[] = [];
  for (let parent = fiber.return; parent !== null; parent = parent.return) {
    if (!COMPONENT_TAGS.has(parent.tag)) continue;
    const name = componentName(parent);
    if (name !== null) owners.push(name);
  }
  return owners;
}

export function installReactCommitCounter() {
  const lastSeen = new WeakMap<Fiber, number>();
  let commit = 0;
  let recording = false;
  const rendered: RenderedComponent[] = [];
  const renderers = new Map<number, unknown>();

  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
    inject(renderer: unknown) {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    checkDCE() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      commit += 1;
      const stack: Fiber[] = [root.current];
      while (stack.length > 0) {
        const fiber = stack.pop()!;
        const previous = lastSeen.get(fiber);
        lastSeen.set(fiber, commit);
        if (
          recording &&
          previous !== commit - 1 &&
          COMPONENT_TAGS.has(fiber.tag) &&
          (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK
        ) {
          const name = componentName(fiber);
          if (name !== null) rendered.push({ name, owners: ownersOf(fiber) });
        }
        if (fiber.sibling !== null) stack.push(fiber.sibling);
        if (fiber.child !== null) stack.push(fiber.child);
      }
    },
  };

  return {
    /** Forgets what was recorded and records from here on. */
    start: () => {
      rendered.length = 0;
      recording = true;
    },
    /** Stops recording and returns every component render since `start`. */
    stop: (): ReadonlyArray<RenderedComponent> => {
      recording = false;
      return [...rendered];
    },
  };
}
