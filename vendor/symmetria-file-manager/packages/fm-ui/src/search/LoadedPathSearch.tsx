import { SearchField } from "../components/SearchField.tsx";
import type { useSearchSession } from "../useSearch.ts";

export function LoadedPathSearch({
  search,
}: {
  readonly search: ReturnType<typeof useSearchSession>;
}) {
  if (!search.active && search.query === "") return null;
  const count = (
    <span role="status" aria-label="Search results" className="overview-search-count">
      {search.position} / {search.matchCount} · loaded paths
    </span>
  );
  return (
    <div className="overview-search" data-editing={search.active}>
      {search.active ? (
        <SearchField
          query={search.query}
          matchCount={search.matchCount}
          label="Search loaded paths"
          count={count}
          onChange={search.setQuery}
          onConfirm={search.confirm}
          onCancel={search.cancel}
        />
      ) : (
        <>
          <span className="overview-search-query" title={search.query}>
            /{search.query}
          </span>
          {count}
        </>
      )}
      <button
        type="button"
        onClick={search.active ? search.cancel : search.clear}
        aria-label={search.active ? "Cancel search" : "Clear search"}
      >
        ×
      </button>
    </div>
  );
}
