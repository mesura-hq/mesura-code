import { breadcrumbs } from "@symmetria/fm-core/pane";

export interface PathBarProps {
  readonly path: string;
  /** Go to a segment. Absent leaves every crumb inert. */
  readonly onNavigate?: (path: string) => void;
}

/**
 * The location, as segments.
 *
 * A breadcrumb, not an editable field. The Qt version's path bar was read-only
 * too; the PRD promised editing and it was never built, so this is parity with
 * what exists rather than with what was written down. Clicking a crumb is
 * navigation, which is a different thing from editing the path.
 *
 * The last crumb is inert because it is where we already are, and it stays a
 * `span` rather than becoming a disabled control — there is nothing to disable
 * when there was never anything to press.
 *
 * The two suppressed accessibility rules want a focusable element with its own
 * key handler. Every location a crumb points at is already reachable by
 * keyboard — `h` walks up one segment at a time — so a crumb adds a pointer
 * shortcut rather than a capability, and making it focusable would put it in
 * the tab order ahead of the list and take keys from the document keymap. The
 * same reasoning, at more length, is in `FileRow.tsx`.
 */
export function PathBar({ path, onNavigate }: PathBarProps) {
  const crumbs = breadcrumbs(path);

  return (
    <nav data-testid="path-bar" className="path-bar">
      {crumbs.map((crumb, index) => {
        const isCurrent = index === crumbs.length - 1;
        const clickable = !isCurrent && onNavigate !== undefined;

        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut, see above
          // biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut, see above
          <span
            key={crumb.path}
            data-testid={isCurrent ? "crumb-current" : "crumb"}
            className={`crumb${isCurrent ? " crumb--current" : ""}${
              clickable ? " crumb--clickable" : ""
            }`}
            // Focus stays where it was, for the same reason it does on a row:
            // the document-level key handler owns the keymap, and a focused
            // crumb would swallow every key that followed the click.
            onMouseDown={clickable ? (event) => event.preventDefault() : undefined}
            onClick={clickable ? () => onNavigate(crumb.path) : undefined}
          >
            {crumb.label}
          </span>
        );
      })}
    </nav>
  );
}
