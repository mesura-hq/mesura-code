import { create } from "zustand";

/**
 * Unsaved-edit flags per project, kept out of `ChatView` state so a typing burst does not re-render the
 * chat view; `ChatView` only writes. Keyed by `${environmentId}:${workspaceRoot}`, so two threads on
 * one project share it.
 */
interface FileSurfacePendingState {
  readonly pendingByProject: ReadonlyMap<string, ReadonlySet<string>>;
  readonly setPending: (projectKey: string, surfaceId: string, pending: boolean) => void;
}

const NOTHING_PENDING: ReadonlySet<string> = new Set();

export const useFileSurfacePendingStore = create<FileSurfacePendingState>((set) => ({
  pendingByProject: new Map(),
  setPending: (projectKey, surfaceId, pending) =>
    set((state) => {
      const current = state.pendingByProject.get(projectKey) ?? NOTHING_PENDING;
      if (current.has(surfaceId) === pending) return state;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const pendingByProject = new Map(state.pendingByProject);
      if (next.size === 0) pendingByProject.delete(projectKey);
      else pendingByProject.set(projectKey, next);
      return { pendingByProject };
    }),
}));

/** Whether one surface has an unsaved edit; re-renders only when that answer changes. */
export function useFileSurfacePending(
  projectKey: string | null,
  surfaceId: string | null,
): boolean {
  return useFileSurfacePendingStore((state) =>
    projectKey === null || surfaceId === null
      ? false
      : (state.pendingByProject.get(projectKey)?.has(surfaceId) ?? false),
  );
}

/** The pending marker on a panel tab: a dot in the tab's icon corner. */
export function FileSurfacePendingMarker(props: {
  readonly projectKey: string | null;
  readonly surfaceId: string;
}) {
  const pending = useFileSurfacePending(props.projectKey, props.surfaceId);
  return pending ? (
    <span
      className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
      aria-hidden
    />
  ) : null;
}
