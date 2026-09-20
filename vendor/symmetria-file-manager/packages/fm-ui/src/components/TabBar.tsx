import type { TabView } from "../useTabs.ts";

export interface TabBarProps {
  readonly visible?: boolean;
  readonly views: readonly TabView[];
  readonly activeIndex: number;
  onActivate(index: number): void;
  onClose(index: number): void;
}

/**
 * The open locations, as a strip.
 *
 * Shown only when there is more than one, so a single-tab window spends no
 * height on a control that says nothing. Each tab is named by its directory,
 * which is what the user navigated to and thinks of it as; the full path is the
 * title, for the case where two tabs share a name.
 */
export function TabBar({ views, activeIndex, onActivate, onClose, visible = true }: TabBarProps) {
  if (!visible) return null;
  return (
    <nav className="tab-bar" data-testid="tab-bar">
      {views.map((view, index) => (
        <span
          key={view.id}
          className={index === activeIndex ? "tab tab--active" : "tab"}
          data-testid="tab"
          data-active={index === activeIndex ? "true" : undefined}
          title={view.path}
        >
          <button type="button" className="tab__name" onClick={() => onActivate(index)}>
            {view.name}
          </button>
          <button
            type="button"
            className="tab__close"
            aria-label={`Close ${view.name}`}
            onClick={() => onClose(index)}
          >
            ×
          </button>
        </span>
      ))}
    </nav>
  );
}
