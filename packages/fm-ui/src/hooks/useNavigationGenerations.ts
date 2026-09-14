import { useCallback, useRef } from "react";

/** User navigation invalidates a view-return context even when the path repeats. */
export function useNavigationGenerations(id: string | undefined) {
  const generations = useRef(new Map<string, number>());
  const read = useCallback((id: string | undefined) => generations.current.get(id ?? "") ?? 0, []);
  const note = useCallback((id: string | undefined) => {
    if (id !== undefined) generations.current.set(id, (generations.current.get(id) ?? 0) + 1);
  }, []);
  const release = useCallback((id: string) => {
    generations.current.delete(id);
  }, []);
  const current = useCallback(() => read(id), [read, id]);
  return { current, note, release };
}
