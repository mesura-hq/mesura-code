import { FolderPlusIcon, LoaderCircleIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useResponsiveSearchInput } from "./useResponsiveSearchInput";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, clearSearch: () => void) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
  /** Mesura: sits at the right inside the Search field, before the clear X. */
  renderSearchFieldAccessory?: (query: string) => ReactNode;
}

export function SidebarThreadHeader({
  searchFieldRef,
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
  renderSearchFieldAccessory,
}: SidebarThreadHeaderProps) {
  const input = useResponsiveSearchInput(searchQuery, onSearchQueryChange);
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists =
    !input.isPending && resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";

  return (
    <div className="flex items-center gap-1">
      {/* Mesura: upstream's focus state without its `redesign:` gate. `threadSearch.toggle`
          lands here from anywhere, and an unmarked field made the command look dead. */}
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70"
      >
        <span className="relative size-4 shrink-0 text-(--sidebar-icon-color)">
          <SearchIcon
            className={cn(
              "size-4 transition-opacity duration-0",
              input.isPending && "opacity-0 delay-150",
            )}
          />
          <LoaderCircleIcon
            aria-hidden="true"
            className={cn(
              "absolute inset-0 size-4 transition-opacity duration-0",
              input.isPending ? "animate-spin opacity-100 delay-150" : "opacity-0",
            )}
          />
        </span>
        <SidebarInput
          ref={searchInputRef}
          nativeInput
          type="search"
          value={input.value}
          onChange={(event) => input.onChange(event.currentTarget.value)}
          aria-busy={input.isPending}
          onKeyDown={(event) => onSearchKeyDown(event, () => input.onChange("", onClearSearch))}
          placeholder="Search"
          aria-label="Search threads"
          // Mesura: Down from the empty field enters the thread list (sidebarThreadViewport.ts).
          data-mesura-thread-search=""
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
          className="min-w-0 flex-1"
        />
        {renderSearchFieldAccessory?.(input.value)}
        {input.value.trim().length > 0 ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="shrink-0"
            aria-label="Clear thread search"
            onClick={() => {
              input.onChange("", onClearSearch);
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">
        {hasProjects ? (
          <>
            {projectScope}
            <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          </>
        ) : null}
        <SidebarHeaderIconButton
          label="New thread"
          tooltip={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  New thread in current project: Shift+click
                  {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
          disabled={newThreadDisabled}
          onClick={onNewThread}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
