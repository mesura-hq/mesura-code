import { isReservedLetter, labelFor } from "@symmetria/fm-core/bookmarks";
import type { BookmarkSubMode, KeyActions, KeyState } from "@symmetria/fm-core/keys/types";
import { boundaryIndex, cursorEntry, isDirectoryEntry, joinPath } from "@symmetria/fm-core/pane";
import { useMemo, useState } from "react";
import type { Bookmarks } from "./useBookmarks.ts";
import type { FileOps } from "./useFileOps.ts";
import type { Picker } from "./usePicker.ts";
import type { Search } from "./useSearch.ts";
import type { Tabs } from "./useTabs.ts";

/**
 * The host's half of the keyboard contract.
 *
 * The registry says WHICH operation a key means; this says what the operation
 * does. Splitting them is what lets the whole keymap be tested without a window
 * — and it is what makes the gap below visible rather than hidden.
 *
 * ── Operations that do not exist yet ────────────────────────────────────────
 * The registry is ported whole, so it names operations later phases build:
 * file operations, tabs, previews, the fuzzy finder, flash jump. Rather than
 * omit those rows — which would make the cheat sheet lie — each one reports
 * that it is not built yet. A key that says "not yet" is honest; a key that
 * silently does nothing is a bug report waiting to happen.
 */

/** Modes the cascade needs and the host owns. */
interface KeyModes {
  readonly chordPrefix: string;
  readonly bookmarkSubMode: BookmarkSubMode | null;
  readonly helpOpen: boolean;
  readonly zoxideOpen: boolean;
  readonly finderOpen: boolean;
  readonly message: string | null;
  closeHelp(): void;
  closeZoxide(): void;
  closeFinder(): void;
  clearMessage(): void;
  reset(): void;
}

export interface KeyWiring {
  readonly actions: KeyActions;
  readonly modes: KeyModes;
  readonly state: KeyState;
}

/**
 * Is the cursor on a directory? Deciding enter-versus-open needs only this.
 *
 * The predicate itself is shared with the pointer, which asks the same question
 * about a clicked row rather than about the cursor.
 */
function isDirectoryUnderCursor(tabs: Tabs): boolean {
  return isDirectoryEntry(cursorEntry(tabs.pane));
}

/**
 * What Enter does to whatever the cursor is on.
 *
 * A directory is always ENTERED, in a dialog as much as in the file manager:
 * browsing is how you reach the file you came for, and a dialog that confirmed
 * the directory under the cursor could never be navigated.
 *
 * **A file in a dialog is CONFIRMED, and never handed to the desktop.** That
 * fall-through was a real defect: driven for real, Enter in a file dialog
 * launched a terminal running an editor on the highlighted file, and only the
 * virtual display kept that window off the operator's session. The Qt build
 * routes Enter through the same `confirmPickerSelection` its Accept button
 * uses, for exactly this reason.
 *
 * Confirming is itself refused when the dialog will not take what is under the
 * cursor — a file in a folder picker — so nothing happens at all rather than
 * something happening in another application.
 */
function activateUnderCursor(tabs: Tabs, ops: FileOps, picker: Picker): void {
  if (isDirectoryUnderCursor(tabs)) {
    tabs.enter();
    return;
  }
  if (picker.state.active) {
    picker.confirmIfActive();
    return;
  }
  ops.open();
}

/**
 * Roughly half a screen of rows.
 *
 * The Qt original asked the view for its own metric. Nothing reports one yet,
 * so this derives from the window: at a 24-pixel row, half the viewport is a
 * usable approximation and is never zero.
 */
function halfPageRows(): number {
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  return Math.max(1, Math.floor(viewport / 2 / 24));
}

export function useKeyActions(
  tabs: Tabs,
  ops: FileOps,
  search: Search,
  bookmarks: Bookmarks,
  /** Where the tilde goes. Supplied by the caller, which reads the window URL. */
  home: string,
  /**
   * The MIME type of the image under the cursor, or null when it is not one.
   *
   * Supplied by the caller because the answer comes from the preview, which
   * asks the main process about the cursor entry and is debounced. This hook
   * has no way to know it, and the field it fills was hardcoded to "not an
   * image" from the phase that introduced it — so the copy chord's image row
   * never appeared and `i` always answered "Not an image".
   */
  cursorImageMime: string | null,
  /**
   * The dialog this window is, when it is one.
   *
   * The registry's picker suppression has been ported and INERT since the phase
   * that introduced it, because the state below was built with `active: false`
   * hardcoded. Threading the real thing here is what makes it run.
   */
  picker: Picker,
  /**
   * Play or pause the audio under the cursor.
   *
   * Supplied by the caller for the same reason `cursorImageMime` is: the state
   * belongs to `App`, which is the only place that knows where the cursor is
   * and can therefore tell when the request stops applying.
   */
  toggleAudioPlayback: () => void,
  /**
   * Begin a flash session.
   *
   * Supplied by the caller rather than built here, like the two above: the
   * session needs the listing, the cursor and the pane, and this hook holds
   * none of them. Passed as the bare function rather than the whole hook so its
   * identity is stable — the hook's own object changes on every keystroke of a
   * running session, and the whole action table would be rebuilt with it.
   */
  startFlash: () => void,
): KeyWiring {
  const [chordPrefix, setChordPrefix] = useState("");
  const [bookmarkSubMode, setBookmarkSubMode] = useState<BookmarkSubMode | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [zoxideOpen, setZoxideOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const actions = useMemo<KeyActions>(() => {
    const soon = (what: string) => () => setMessage(`${what} is not built yet`);

    return {
      // Navigation — the operations this phase can actually perform.
      moveDown: () => tabs.moveBy(1),
      moveUp: () => tabs.moveBy(-1),
      jumpToTop: () => tabs.moveTo(0),
      jumpToBottom: () => tabs.moveTo(tabs.pane.entries.length - 1),
      halfPageDown: () => tabs.moveBy(halfPageRows()),
      halfPageUp: () => tabs.moveBy(-halfPageRows()),
      activate: () => activateUnderCursor(tabs, ops, picker),
      goUp: () => tabs.leave(),
      enterDirectory: () => activateUnderCursor(tabs, ops, picker),
      goHome: () => tabs.navigate(home),
      jumpDirectoryFileBoundary: () => {
        // -1 means the listing holds one kind, or none. Leaving the cursor put
        // is the honest answer: there is no other block to be at the start of.
        const target = boundaryIndex(tabs.pane);
        if (target >= 0) tabs.moveTo(target);
      },
      // Escape, once the cascade has found nothing else that wants it. In a
      // dialog that is the user giving up, and the caller blocked on the pipe
      // has to be told — the pre-pass routes Escape here.
      dismiss: () => {
        setMessage(null);
        picker.cancelIfActive();
      },

      historyBack: () => tabs.historyBack(),
      historyForward: () => tabs.historyForward(),

      trash: () => ops.requestDelete(),
      rename: (withExtension) => ops.requestRename(withExtension),
      createEntry: () => ops.requestCreate(),
      // The `op.pickerSaveEdit` binding, gated on save mode by the registry.
      editSaveName: () => picker.focusSaveName(),

      yank: () => ops.yank(),
      cut: () => ops.cut(),
      paste: () => ops.paste(),
      copyToClipboard: (target) => ops.copyToClipboard(target),

      toggleSelection: () => tabs.toggleMark(),
      clearSelection: () => tabs.clearMarks(),

      startSearch: () => search.open(),
      nextMatch: () => search.goNext(),
      previousMatch: () => search.goPrevious(),
      startFlash,
      openFuzzyFinder: () => setFinderOpen(true),
      openZoxide: () => setZoxideOpen(true),

      // Chords resolve for real; what they resolve TO may not exist yet.
      setChordPrefix,
      startBookmarkSubMode: setBookmarkSubMode,
      exitBookmarkSubMode: () => setBookmarkSubMode(null),
      navigateToBookmark: (letter) => {
        const path = bookmarks.pathFor(letter);
        // Saying which letter is empty beats a silent no-op: the user pressed
        // `g` and then something, and needs to know the second key was heard.
        if (path === null) setMessage(`No bookmark on ${letter}`);
        else tabs.navigate(path);
      },
      assignBookmark: (letter) => {
        // The store drops a reserved letter on read, so binding one would look
        // like a save that worked and be gone after a restart. Refusing here
        // and saying which letter is the honest version of the same rule.
        if (isReservedLetter(letter)) {
          setMessage(`${letter} is reserved`);
          return;
        }
        const path = tabs.pane.path;
        const label = labelFor(path);
        bookmarks.assign(letter, { path, label });
        setMessage(`${letter} → ${label}`);
      },
      deleteBookmark: (letter) => {
        if (isReservedLetter(letter)) {
          setMessage(`${letter} is reserved`);
          return;
        }
        // Silent for a letter that was not bound: the user asked for it to be
        // gone and it is.
        if (bookmarks.pathFor(letter) !== null) setMessage(`${letter} removed`);
        bookmarks.remove(letter);
      },
      setSort: (sort, reverse) => tabs.setSort(sort, reverse),
      showMessage: setMessage,

      toggleViewMode: soon("The tree view"),
      toggleHidden: () => tabs.toggleHidden(),
      toggleDocumentRender: () => tabs.toggleRenderDocuments(),
      openContextMenu: soon("The context menu"),
      openCopyingPath: () => {
        // **The same hole as plain Enter, one key over.** Review found it right
        // after the Enter fix landed: this handed the cursor entry to the
        // desktop's default application unconditionally, including from inside
        // a dialog — and a dialog that spawns a terminal on the operator's
        // session is the defect verification actually watched happen.
        //
        // In a dialog the binding does what its name says and no more: the path
        // goes on the clipboard, and the dialog confirms. Outside one it is the
        // ordinary open it has always been.
        if (!picker.state.active) {
          ops.open();
          return;
        }
        ops.copyToClipboard("path");
        picker.confirmIfActive();
      },

      tabNew: () => tabs.open(),
      tabClose: () => tabs.close(),
      tabNext: () => tabs.goNext(),
      tabPrevious: () => tabs.goPrevious(),

      toggleAudioPlayback,

      openHelp: () => setHelpOpen(true),

      treeCollapseOrParent: soon("The tree view"),
      treeExpandOrActivate: soon("The tree view"),
      treeToggleExpand: soon("The tree view"),
      treeToggleHidden: soon("The tree view"),
      treePageDown: () => undefined,
      treePageUp: () => undefined,
      treeRefresh: soon("The tree view"),
    };
  }, [tabs, ops, search, bookmarks, home, picker, toggleAudioPlayback, startFlash]);

  const state = useMemo<KeyState>(() => {
    const entry = tabs.pane.entries[tabs.pane.cursorIndex];
    return {
      selectedCount: tabs.pane.selection.size,
      searchActive: search.active,
      matchCount: search.matchCount,
      cursorEntry:
        entry === undefined
          ? null
          : {
              name: entry.name,
              path: joinPath(tabs.pane.path, entry.name),
              isDirectory: entry.kind === "directory",
              // Both come from the preview's route, which the caller resolves
              // and hands in. They therefore AGREE by construction FROM THIS
              // HOST: the router only reports an image for a MIME its tables
              // call one, so the chord's second guard — "Can't copy this image
              // format" — cannot fire here.
              //
              // That guard is NOT dead code. The chord lives in the shared
              // package, its own suite drives it against a hand-built context
              // where the two disagree, and a host that fed a real content
              // sniff in here would reach it — an RPG-Maker `.rpgmvp` sniffs as
              // an image and reports `application/octet-stream`.
              isImage: cursorImageMime !== null,
              mimeType: cursorImageMime ?? "",
            },
      picker: picker.state,
    };
  }, [tabs.pane, search.active, search.matchCount, cursorImageMime, picker.state]);

  const modes = useMemo<KeyModes>(
    () => ({
      chordPrefix,
      bookmarkSubMode,
      helpOpen,
      zoxideOpen,
      finderOpen,
      message,
      closeHelp: () => setHelpOpen(false),
      closeZoxide: () => setZoxideOpen(false),
      closeFinder: () => setFinderOpen(false),
      clearMessage: () => setMessage(null),
      reset: () => {
        setChordPrefix("");
        setBookmarkSubMode(null);
        setHelpOpen(false);
        setZoxideOpen(false);
        setFinderOpen(false);
      },
    }),
    [chordPrefix, bookmarkSubMode, helpOpen, zoxideOpen, finderOpen, message],
  );

  return { actions, modes, state };
}
