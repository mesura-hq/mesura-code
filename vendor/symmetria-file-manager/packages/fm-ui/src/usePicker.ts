import type { PickerState } from "@symmetria/fm-core/keys/types";
import { cursorEntry, isDirectoryEntry, joinPath } from "@symmetria/fm-core/pane";
import {
  type PickerSelectionContext,
  pickerAcceptEnabled,
  pickerAcceptLabel,
  resolvePickerSelection,
} from "@symmetria/fm-core/pickerSelection";
import type { PickerWindowRequest } from "@symmetria/fm-core/windowUrl";
import { useCallback, useMemo, useRef, useState } from "react";

import { pickerCancel, pickerConfirm } from "./bridge.ts";
import type { Tabs } from "./useTabs.ts";

/**
 * The panel, when it is a file dialog.
 *
 * Its own hook rather than lines inside `App`, and not for tidiness: the
 * complexity gate counts each hook call in a component, `App` already sits at
 * its bound, and `useExternalOpen` was extracted for exactly this reason one
 * phase earlier. Discovering that at the gate costs a lap.
 *
 * **The decisions are not here.** Which paths a confirm returns, what the button
 * says and whether it can be pressed all come from `pickerSelection.ts` in the
 * shared package, where the whole truth table is a unit test. This hook supplies
 * that function with what the panel knows and carries its answer to the bridge.
 */

/** What the status bar draws when the panel is a dialog. */
export interface PickerChrome {
  readonly acceptLabel: string;
  readonly acceptEnabled: boolean;
  readonly saveMode: boolean;
  readonly saveName: string;
  setSaveName(name: string): void;
  /** The field, so the keyboard can put the cursor in it. */
  readonly saveNameRef: React.RefObject<HTMLInputElement | null>;
  confirm(): void;
  cancel(): void;
}

export interface Picker {
  /** What the key registry reads. All false in the browse window. */
  readonly state: PickerState;
  /** Null in the browse window, which must be untouched by any of this. */
  readonly chrome: PickerChrome | null;
  /** Put the cursor in the filename field. The `op.pickerSaveEdit` binding. */
  focusSaveName(): void;
  /** Cancel, if this is a dialog. What Escape reaches once nothing else wants it. */
  cancelIfActive(): void;
  /**
   * Confirm, if this is a dialog and the selection is one it accepts.
   *
   * What Enter must reach on a FILE. It used to fall through to the ordinary
   * activate, which hands the file to the desktop's default application —
   * verification watched that launch a terminal running an editor, and on the
   * operator's own session that window would have appeared on their desktop.
   */
  confirmIfActive(): void;
}

/** Every flag off. The browse window's answer, and the shape the registry expects. */
const INERT: PickerState = {
  active: false,
  saveMode: false,
  fileOps: false,
  multiple: false,
  directory: false,
};

export function usePicker(request: PickerWindowRequest | null, tabs: Tabs): Picker {
  // Seeded from the request and then owned here, because the user edits it.
  const [saveName, setSaveName] = useState(request?.options.suggestedName ?? "");
  const saveNameRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    // The selection is a set of NAMES — a file deleted underfoot must not leave
    // a stale path behind — so the path is joined here. The KIND travels with
    // it because a type-constrained dialog must not return a folder to a caller
    // that asked for a file, and a bare path cannot say which it is.
    () =>
      [...tabs.pane.selection].flatMap((name) => {
        const entry = tabs.pane.entries.find((each) => each.name === name);
        if (entry === undefined) return [];
        return [{ path: joinPath(tabs.pane.path, name), isDirectory: isDirectoryEntry(entry) }];
      }),
    [tabs.pane.selection, tabs.pane.path, tabs.pane.entries],
  );

  const context = useMemo<PickerSelectionContext | null>(() => {
    if (request === null) return null;
    const entry = cursorEntry(tabs.pane);
    return {
      multiple: request.options.multiple,
      directory: request.options.directory,
      saveMode: request.options.saveMode,
      currentPath: tabs.pane.path,
      suggestedName: saveName,
      selected,
      cursorEntry:
        entry === null
          ? null
          : {
              path: joinPath(tabs.pane.path, entry.name),
              isDirectory: isDirectoryEntry(entry),
            },
    };
  }, [request, tabs.pane, saveName, selected]);

  const fifo = request?.fifo ?? null;

  const confirm = useCallback(() => {
    if (fifo === null || context === null) return;
    const resolved = resolvePickerSelection(context);
    // A refusal is silent on purpose: the button is disabled in the same
    // situation, and both come from this one function so they cannot disagree.
    // Answering with nothing would read to the portal as a confirmed selection.
    if (resolved.kind !== "paths") return;
    void pickerConfirm({ fifo, paths: resolved.paths });
  }, [fifo, context]);

  const cancel = useCallback(() => {
    if (fifo === null) return;
    void pickerCancel({ fifo });
  }, [fifo]);

  const state = useMemo<PickerState>(
    () =>
      request === null
        ? INERT
        : {
            active: true,
            saveMode: request.options.saveMode,
            // Deferred deliberately: no consumer sets it, and the plan says so.
            // The suppression pre-pass already honours the flag.
            fileOps: false,
            multiple: request.options.multiple,
            directory: request.options.directory,
          },
    [request],
  );

  const chrome = useMemo<PickerChrome | null>(
    () =>
      request === null || context === null
        ? null
        : {
            acceptLabel: pickerAcceptLabel(context, request.options.acceptLabel),
            acceptEnabled: pickerAcceptEnabled(context),
            saveMode: request.options.saveMode,
            saveName,
            setSaveName,
            saveNameRef,
            confirm,
            cancel,
          },
    [request, context, saveName, confirm, cancel],
  );

  // Stable, because `useKeyActions` memoises its action table on them. A fresh
  // arrow each render would rebuild that table on every keystroke.
  const focusSaveName = useCallback(() => saveNameRef.current?.focus(), []);

  // **The whole object is memoised, and without this the memos above are
  // decoration.** `useKeyActions` depends on this value, so a fresh literal
  // each render rebuilds the entire action table on every keystroke — which is
  // exactly what the comment above claimed it prevented. Review found the
  // contradiction.
  return useMemo(
    () => ({ state, chrome, focusSaveName, cancelIfActive: cancel, confirmIfActive: confirm }),
    [state, chrome, focusSaveName, cancel, confirm],
  );
}
