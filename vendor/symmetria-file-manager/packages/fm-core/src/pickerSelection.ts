/**
 * What a confirmed picker returns, and what its Accept button says.
 *
 * Ported from `confirmPickerSelection` in the Qt build's
 * `FileManagerService.qml`, which is the single source of truth there for both
 * the Enter key and the Accept button. Kept pure and kept HERE, in the package
 * that compiles against no environment, for two reasons: the whole truth table
 * becomes a unit test rather than four rendering tests, and the label, the
 * enabled state and the answer are derived from one function each so they
 * cannot come to disagree.
 *
 * That last point is not hypothetical. In the Qt original the label ladder and
 * the enabled ladder are written out separately in `StatusBar.qml`, and a
 * button that looks pressable and then does nothing is worse than one that is
 * visibly disabled.
 */

/** One row, reduced to the two things a picker decision needs. */
export interface PickerCursorEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

/** Everything the three functions below read. Nothing else about the panel. */
export interface PickerSelectionContext {
  readonly multiple: boolean;
  readonly directory: boolean;
  readonly saveMode: boolean;
  /** The directory the dialog is showing. */
  readonly currentPath: string;
  /** What is in the save-filename field, which the user may have edited. */
  readonly suggestedName: string;
  readonly selected: readonly PickerCursorEntry[];
  readonly cursorEntry: PickerCursorEntry | null;
}

export type PickerResolution =
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  /** Confirming would answer nothing, so it must not answer at all. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The marks this dialog would actually accept.
 *
 * Type-filtered, like the single-cursor branch and for the same reason. The Qt
 * build filters at MARK time; this port filters here, which reaches the same
 * place from the other end — a folder marked in a file-only dialog is simply
 * not part of the answer. Without it a caller that asked for files could be
 * handed a directory, and review found the marked branch was the one place the
 * kind was never checked at all.
 *
 * Shared with the LABEL, so the number on the button is the number of paths
 * pressing it returns.
 */
function usableMarks(context: PickerSelectionContext): readonly PickerCursorEntry[] {
  return context.selected.filter((each) => each.isDirectory === context.directory);
}

/** Join without doubling the separator — `currentPath` is `/` at the root. */
function joinName(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

export function resolvePickerSelection(context: PickerSelectionContext): PickerResolution {
  // **Save mode first, and this DIVERGES from the Qt code on purpose.**
  //
  // `confirmPickerSelection` checks multi-select-with-marks first and save mode
  // second — but the comment directly above that check says "pickerSaveMode and
  // pickerMultiple are orthogonal — save mode ignores marks", which the order
  // below it does not do. The comment describes the intent and the code does
  // something else.
  //
  // Following the intent, because the alternative is a save dialog that returns
  // marked files instead of the name being typed, and writes to the wrong
  // place. The divergence is unobservable in practice: `SaveFile` in
  // `portal/symmetria_portal.py` sends `multiple: False`, so no real request
  // reaches this fork with both set.
  if (context.saveMode) {
    // A bare directory is a real answer when no name has been given: the portal
    // appends its own `current_name` — see `SaveFile` in `symmetria_portal.py`,
    // which joins when what comes back is a directory.
    const path =
      context.suggestedName === ""
        ? context.currentPath
        : joinName(context.currentPath, context.suggestedName);
    return { kind: "paths", paths: [path] };
  }

  if (context.multiple) {
    const usable = usableMarks(context);
    if (usable.length > 0) return { kind: "paths", paths: usable.map((each) => each.path) };
  }

  // Everything below answers with the row under the cursor, including a
  // multi-select dialog with nothing marked — pressing Enter without marking is
  // the common case even there, and an empty list would read to the portal as a
  // confirmed selection of nothing.
  const entry = context.cursorEntry;
  if (entry === null) return { kind: "refused", reason: "there is nothing under the cursor" };

  if (context.directory !== entry.isDirectory) {
    return {
      kind: "refused",
      reason: context.directory ? "this dialog wants a folder" : "this dialog wants a file",
    };
  }

  return { kind: "paths", paths: [entry.path] };
}

/**
 * What the Accept button says.
 *
 * The caller's own word wins: the portal passes `accept_label`, and an
 * application that asked for "Attach" should not be given a button saying
 * something else.
 */
export function pickerAcceptLabel(context: PickerSelectionContext, acceptLabel: string): string {
  if (acceptLabel !== "") return acceptLabel;
  if (context.saveMode) return "Save";

  // Counted the same way the answer is filtered, so the number on the button is
  // the number of paths that would actually be returned. A count that included
  // marks the dialog will not take would promise more than pressing it delivers.
  const usable = usableMarks(context);
  if (context.multiple && usable.length > 0) return `Select (${usable.length})`;

  // The Qt build's word. The plan said "Open"; `StatusBar.qml` says "Select",
  // and matching the application the operator uses daily is what parity means.
  return "Select";
}

/**
 * Whether pressing it would do anything.
 *
 * Derived from `resolvePickerSelection` rather than written out again, which is
 * the whole reason both live in this file. Two ladders written separately drift,
 * and the drift shows up as a button that looks pressable and does nothing.
 */
export function pickerAcceptEnabled(context: PickerSelectionContext): boolean {
  return resolvePickerSelection(context).kind === "paths";
}
