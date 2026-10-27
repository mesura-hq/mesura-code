import { useOptimistic, useTransition } from "react";

/** Paint the field before rendering the results. The committed query also resets clears and picks. */
export function useResponsiveSearchInput(query: string, onQueryChange: (query: string) => void) {
  const [value, setValue] = useOptimistic(query);
  const [isPending, startTransition] = useTransition();
  const onChange = (next: string, commit = onQueryChange) => {
    startTransition(() => {
      setValue(next);
      commit(next);
    });
  };
  return { value, isPending, onChange };
}
