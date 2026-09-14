import type { Bookmark } from "@symmetria/fm-core/bookmarks";
import type { CascadeMode } from "@symmetria/fm-core/keys/cascade";
import type { KeyContext } from "@symmetria/fm-core/keys/types";
import {
  cursorEntry,
  entryAt,
  isDirectoryEntry,
  joinPath,
  type PaneState,
  parentOf,
} from "@symmetria/fm-core/pane";
import {
  homeFromSearch,
  type PickerWindowRequest,
  pickerFromSearch,
} from "@symmetria/fm-core/windowUrl";
import { FinderOverlay } from "@symmetria/fm-search/ui";
import { useEffect, useMemo, useRef } from "react";
import { BrowsingView } from "./components/BrowsingView.tsx";
import { FinderPreview } from "./components/FinderPreview.tsx";
import { HelpOverlay } from "./components/HelpOverlay.tsx";
import { OpsModals } from "./components/modals/OpsModals.tsx";
import type { SearchFieldProps } from "./components/SearchField.tsx";
import { type RenderMode, StatusBar } from "./components/StatusBar.tsx";
import { TabBar } from "./components/TabBar.tsx";
import type { TransientLineProps } from "./components/transientLine.tsx";
import { WhichKeyOverlay } from "./components/WhichKeyOverlay.tsx";
import { ZoxidePopup } from "./components/ZoxidePopup.tsx";
import { useKeyDispatch } from "./hooks/useKeyDispatch.ts";
import { OverviewLayer } from "./overview/Overview.tsx";
import { useOverviewMode } from "./overview/useOverviewMode.ts";
import { treeDirectoryError, treeSummary } from "./tree/TreeSummary.tsx";
import { treeKeyContext, useTreeMode } from "./tree/useTreeMode.ts";
import { useBookmarks } from "./useBookmarks.ts";
import { useExternalOpen } from "./useExternalOpen.ts";
import { type FileOps, useFileOps } from "./useFileOps.ts";
import { type FlashHost, type PreviewedDirectory, useFlash } from "./useFlash.ts";
import { type KeyWiring, useKeyActions } from "./useKeyActions.ts";
import { usePicker } from "./usePicker.ts";
import { type Preview, usePreviewPane } from "./usePreview.ts";
import { type Search, useSearch } from "./useSearch.ts";
import { type Tabs, useTabs } from "./useTabs.ts";

/**
 * Where a window opens when nothing says otherwise.
 *
 * The home directory, read from the location hash so the main process can open
 * a window elsewhere without a second channel. Falling back to `/` rather than
 * throwing keeps a window with a malformed hash usable.
 */
function initialPath(override?: string): string {
  const requested = override ?? decodeURIComponent(window.location.hash.replace(/^#/, ""));
  return requested.startsWith("/") ? requested : "/";
}

/**
 * Where the tilde goes.
 *
 * Read through `homeFromSearch`, which the MAIN process's URL builder is the
 * other half of — see that module for why the query and the fragment are two
 * different facts. A new IPC channel was the alternative and is more privileged
 * surface for one constant; reading it from the `h` bookmark was the other, and
 * the user can unbind `h`.
 */
function homePath(override?: string): string {
  return override ?? homeFromSearch(window.location.search);
}

/** The absolute path of the entry under the cursor, or none. */
function cursorPathOf(pane: PaneState): string | null {
  const entry = cursorEntry(pane);
  return entry === null ? null : joinPath(pane.path, entry.name);
}

/**
 * The MIME type of the image under the cursor, or null.
 *
 * Only when the preview describes THIS entry. It is debounced by 150 ms so a
 * fast j/k does not describe every row it passes over — which means that just
 * after a cursor move the route still describes the previous entry, and copying
 * the image the cursor has just left is exactly the kind of wrong that looks
 * right.
 */
function cursorImageMimeOf(preview: Preview, cursorPath: string | null): string | null {
  if (preview.path !== cursorPath) return null;
  return preview.route.kind === "image" ? preview.route.mime : null;
}

/**
 * Which view the preview is showing, or null when this file has no second one.
 *
 * Guarded on the described path for the same reason the image chord above is:
 * the preview is debounced by 150 ms, so just after a cursor move the route
 * still describes the previous entry — and an indicator that lags the cursor by
 * a beat is worse than none, because it says something definite and wrong.
 */
function renderModeOf(
  preview: Preview,
  cursorPath: string | null,
  renderDocuments: boolean,
): RenderMode | null {
  if (preview.path !== cursorPath || preview.renderAs === null) return null;
  return renderDocuments ? "rendered" : "source";
}

/**
 * The search field's props, or null when no search is open.
 *
 * A module-level function for the same reason `cursorImageMimeOf` and
 * `renderModeOf` above are: `App` is scored as one function and every
 * conditional inside its JSX counts against the same bound.
 */
function searchChromeOf(search: Search): SearchFieldProps | null {
  if (!search.active) return null;
  return {
    query: search.query,
    matchCount: search.matchCount,
    onChange: search.setQuery,
    onConfirm: search.confirm,
    onCancel: search.cancel,
  };
}

/**
 * A failure, a running transfer, or what just happened — whichever there is.
 *
 * The precedence between them belongs to `transientLine`; this only decides
 * which message there is to show, since two sources can offer one.
 */
function transientOf(
  tabs: Tabs,
  ops: FileOps,
  modes: KeyWiring["modes"],
  treeRoot: string | null,
): TransientLineProps {
  return {
    error: treeDirectoryError(treeRoot, tabs.error),
    message: ops.message ?? modes.message,
    progress: ops.progress,
    onCancelTransfer: ops.cancelRunningTransfer,
  };
}

/**
 * The previewed directory a flash session may label, or null.
 *
 * Guarded on the described path for the same reason the two functions above
 * are: the preview is debounced by 150 ms, so just after a cursor move the
 * route still describes the PREVIOUS entry — and a label that navigates
 * somewhere the cursor has already left is the worst kind of wrong, because
 * it does something rather than nothing.
 */
function previewDirectoryOf(
  preview: Preview,
  cursorPath: string | null,
): PreviewedDirectory | null {
  if (preview.path === null || preview.path !== cursorPath) return null;
  if (preview.route.kind !== "directory") return null;
  return { path: preview.path, entries: preview.route.entries };
}

/**
 * What a flash session sees: three columns and two ways to move.
 *
 * A plain function rather than a hook, and it is rebuilt on every render on
 * purpose — `useFlash` keys its own memos on the LISTINGS rather than on this
 * object, so a fresh wrapper costs nothing and there is no dependency array
 * here to fall out of step.
 */
function flashHostFor(tabs: Tabs, preview: Preview, cursorPath: string | null): FlashHost {
  return {
    entries: tabs.pane.entries,
    cursorIndex: tabs.pane.cursorIndex,
    path: tabs.pane.path,
    parentEntries: tabs.parentEntries,
    parentPath: parentOf(tabs.pane.path),
    previewDirectory: previewDirectoryOf(preview, cursorPath),
    moveTo: tabs.moveTo,
    navigateTo: tabs.navigateTo,
  };
}

export interface AppProps {
  readonly onOpenFile?: (path: string) => void;
  /** Overridden by tests, which must not depend on the real location. */
  readonly startPath?: string;
  /** Overridden by tests, for the same reason. */
  readonly homePath?: string;
  /**
   * The dialog this window was opened for, when it is one.
   *
   * Read from the window URL in normal use — the renderer needs it at FIRST
   * render, because a window that painted as a browse view and then became a
   * dialog would flicker. Overridden by tests for the same reason the two above
   * are: a test must not depend on the real location.
   */
  readonly picker?: PickerWindowRequest;
}

/** The dialog request this window carries, or null for the browse window. */
function pickerRequest(override?: PickerWindowRequest): PickerWindowRequest | null {
  return override ?? pickerFromSearch(window.location.search);
}

/**
 * What the dispatch cascade needs to know about modes.
 *
 * Lifted out of `App` because the complexity gate scores a component as one
 * function and this object is most of its branching — `App` reached a cognitive
 * 16 against a bound of 15 the moment the picker was wired in. The same
 * pressure produced `useExternalOpen` and `usePicker`; naming a thing is
 * cheaper than arguing with the measurement.
 */
function cascadeModeFor(
  modes: KeyWiring["modes"],
  opsModalKind: string,
  searchActive: boolean,
  flashActive: boolean,
): CascadeMode {
  return {
    // One gate for every dialog: the help sheet and the operation dialogs
    // share it, so two can never be open at once. The zoxide list joins the
    // same gate — it is a dialog with a text field, and two of those open at
    // once would each think the keyboard was theirs.
    modalOpen: modes.helpOpen || modes.zoxideOpen || modes.finderOpen || opsModalKind !== "none",
    bookmarkSubMode: modes.bookmarkSubMode,
    chordPrefix: modes.chordPrefix,
    // Flash jump is a text-input mode with no input to focus: it reads the raw
    // key stream, so saying so here is the ONLY thing that stops `j` from
    // moving the cursor while a session is narrowing.
    flashActive,
    // The seam the cascade documented and nothing used until now. The field is
    // a real `<input>`, so `useKeyDispatch` would report this anyway from the
    // event target — stating it here as well means a key that arrives while the
    // field is open but not yet focused is still not the dispatcher's.
    textInputFocused: searchActive,
  };
}

/**
 * A double click: move the cursor to what was clicked, then act on it.
 *
 * The order is load-bearing. Acting first would enter or open whatever the
 * cursor happened to be sitting on, which is almost never the row under the
 * pointer. `entryAt` asks about the clicked index rather than the cursor for
 * the same reason.
 *
 * The enter-or-open decision calls `isDirectoryEntry`, which is the same
 * function `useKeyActions` calls for the Enter key. Not the same SHAPE of
 * test — the same function, because two copies would eventually disagree
 * about a symlinked directory, which the scan reports as `directory`
 * precisely so it can be entered.
 */
function activateAt(tabs: Tabs, ops: FileOps, index: number): void {
  tabs.moveTo(index);
  if (isDirectoryEntry(entryAt(tabs.pane, index))) tabs.enter();
  else ops.openAt(index);
}

/**
 * The two things that sit above the panel and take the keyboard.
 *
 * A component rather than two conditionals inside `App`, for the reason the
 * gate keeps making: a component is measured as one function, and `App` reached
 * a cognitive 16 against a bound of 15 the moment the picker was wired in. They
 * belong together anyway — both are gated by the same `modalOpen`, so only one
 * can ever be showing.
 */
function Overlays({
  modes,
  context,
  bookmarks,
  directory,
  renderDocuments,
  onNavigate,
  onReveal,
}: {
  readonly modes: KeyWiring["modes"];
  readonly context: KeyContext;
  readonly bookmarks: ReadonlyMap<string, Bookmark>;
  /** The tree the finder searches: whatever the active pane is showing. */
  readonly directory: string;
  /** Passed through to the finder's preview, as the pane's own preview gets it. */
  readonly renderDocuments: boolean;
  onNavigate(path: string): void;
  onReveal(path: string): void;
}) {
  if (modes.finderOpen) {
    return (
      <FinderOverlay
        directory={directory}
        renderPreview={(path) => <FinderPreview path={path} renderDocuments={renderDocuments} />}
        onChoose={(path, isDir) => {
          modes.closeFinder();
          // A directory is ENTERED and a file is REVEALED. The overlay reports
          // which it handed back rather than leaving the caller to read the
          // engine's trailing separator, which is a convention a caller can get
          // wrong exactly once.
          if (isDir) onNavigate(path);
          else onReveal(path);
        }}
        onClose={modes.closeFinder}
      />
    );
  }
  if (modes.zoxideOpen) {
    return (
      <ZoxidePopup
        onChoose={(path) => {
          modes.closeZoxide();
          onNavigate(path);
        }}
        onClose={modes.closeZoxide}
      />
    );
  }
  if (modes.helpOpen) {
    return <HelpOverlay context={context} bookmarks={bookmarks} onClose={modes.closeHelp} />;
  }
  return null;
}

export function App(props: AppProps = {}) {
  const tabs = useTabs(initialPath(props.startPath));
  const home = homePath(props.homePath);
  const { tree, overview } = useProjectViews(tabs);
  // Memoised because `pickerFromSearch` PARSES the URL: a fresh object each
  // render would defeat every memo inside `usePicker`, and through it the whole
  // key action table. The URL cannot change for this window's lifetime.
  const request = useMemo(() => pickerRequest(props.picker), [props.picker]);
  const picker = usePicker(request, tabs);
  const ops = useFileOps(tabs);
  const search = useSearch({
    entries: tabs.pane.entries,
    cursorIndex: tabs.pane.cursorIndex,
    path: tabs.pane.path,
    moveTo: tabs.moveTo,
  });
  const bookmarks = useBookmarks();

  // Wired here rather than inside `useTabs`, and the placement is the point:
  // `useTabs` owns the tab collection, while composing an external event source
  // onto it is this component's job.
  useExternalOpen((path) => {
    search.cancel();
    modes.reset();
    millerFlash.clear();
    overview.close();
    tree.external(path);
  });

  // The preview is resolved BEFORE the key actions, not after, because one of
  // those actions needs its answer: the copy chord's image row asks whether the
  // cursor is on an image, and only the preview knows. Its input is the cursor
  // path, which comes straight from the pane — so there is no cycle, only an
  // order.
  const cursorPath = cursorPathOf(tabs.pane);
  const previewing = usePreviewPane(cursorPath, tabs.renderDocuments);
  // After the preview, because a session may label the directory it shows.
  const millerFlash = useFlash(flashHostFor(tabs, previewing.preview, cursorPath));

  const { actions, modes, state } = useKeyActions(
    tabs,
    ops,
    search,
    bookmarks,
    home,
    cursorImageMimeOf(previewing.preview, cursorPath),
    picker,
    previewing.toggleAudio,
    millerFlash.start,
  );

  const context = browsingContext(
    picker.state.active,
    search,
    modes,
    tree,
    overview,
    state,
    actions,
  );
  useBrowsingTransitions(tree.id, modes.reset, search.cancel, tree.cancel, millerFlash.clear);
  useBrowsingTransitions(context.view, millerFlash.clear);

  const flash = browsingFlash(context, tree, overview, millerFlash);
  const mode = useMemo<CascadeMode>(
    () => cascadeModeFor(modes, ops.modal.kind, search.active, flash.active),
    [modes, ops.modal.kind, search.active, flash.active],
  );

  useKeyDispatch({
    mode,
    context,
    onFlashKey: flash.onKey,
  });

  /**
   * A click in the parent column: go to that sibling directory.
   *
   * Reached by name rather than by index, because the parent column's own
   * cursor is derived from a name lookup too — see `MillerColumns` — and the
   * two would have to be kept in step if either used an index.
   */
  const leaveTo = (name: string) => tabs.navigate(joinPath(parentOf(tabs.pane.path), name));

  return (
    <>
      <main className="app" inert={overview.root !== null}>
        <TabBar
          visible={tabs.showBar}
          views={tabs.views}
          activeIndex={tabs.activeIndex}
          onActivate={tabs.activate}
          onClose={tabs.close}
        />
        <BrowsingView
          tabs={tabs}
          tree={tree}
          model={overview.treeModel}
          onOpen={props.onOpenFile ?? ops.openAbsolute}
          matches={search.matches}
          preview={previewing.pane}
          flashLabels={millerFlash.labels}
          flashActive={millerFlash.active}
          onVisibleRange={millerFlash.reportVisibleRange}
          onActivate={(index) => activateAt(tabs, ops, index)}
          onLeaveTo={leaveTo}
        />
        <WhichKeyOverlay
          prefix={modes.chordPrefix}
          cursorIsImage={state.cursorEntry?.isImage === true}
          bookmarks={browsingBookmarks(context, bookmarks.byLetter)}
        />
        {/* One bar, and nothing above it that comes and goes. The search field
          and the transient line were rows of their own here, so opening a
          search pushed the columns down and a copy starting pushed them up.
          Both now live inside the bar, which has a fixed height. */}
        <StatusBar
          summary={treeSummary(tree.root, overview.model, tabs.showHidden)}
          picker={picker.chrome}
          entryCount={tabs.pane.entries.length}
          selectedCount={state.selectedCount}
          sort={tabs.sort}
          reverse={tabs.reverse}
          showHidden={tabs.showHidden}
          renderMode={renderModeOf(previewing.preview, cursorPath, tabs.renderDocuments)}
          search={searchChromeOf(search)}
          flash={flash.chrome}
          transient={transientOf(tabs, ops, modes, tree.root)}
        />
        <OpsModals
          modal={ops.modal}
          onCancel={ops.closeModal}
          onConfirmDelete={ops.confirmDelete}
          onConfirmRename={ops.confirmRename}
          onConfirmCreate={ops.confirmCreate}
          onConfirmOverwrite={ops.confirmOverwrite}
        />
      </main>
      <OverviewLayer
        root={overview.root}
        model={overview.model}
        onClose={overview.close}
        port={overview.port}
        minimapVisible={overview.minimapVisible}
        onToggleMinimap={overview.toggleMinimap}
      />
      <Overlays
        modes={modes}
        context={context}
        bookmarks={bookmarks.byLetter}
        directory={tabs.pane.path}
        renderDocuments={tabs.renderDocuments}
        onNavigate={tabs.navigate}
        onReveal={tabs.reveal}
      />
    </>
  );
}

function useBrowsingTransitions(id: string, ...reset: (() => void)[]) {
  const latest = useRef(reset);
  latest.current = reset;
  const previous = useRef(id);
  useEffect(() => {
    if (previous.current === id) return;
    previous.current = id;
    for (const clear of latest.current) clear();
  }, [id]);
}

function browsingBookmarks(context: KeyContext, bookmarks: ReadonlyMap<string, Bookmark>) {
  return context.view === "tree" ? new Map<string, Bookmark>() : bookmarks;
}

function browsingContext(
  pickerActive: boolean,
  search: Search,
  modes: KeyWiring["modes"],
  tree: ReturnType<typeof useTreeMode>,
  overview: ReturnType<typeof useOverviewMode>,
  state: KeyContext["state"],
  actions: KeyContext["actions"],
) {
  const toggleView = () => {
    if (pickerActive) return;
    search.cancel();
    modes.reset();
    tree.cancel();
    tree.open();
  };
  const base: KeyContext = {
    view: overview.view,
    state,
    actions: { ...actions, toggleViewMode: toggleView },
    overview: {
      ...overview,
      toggle: () => {
        tree.cancel();
        overview.toggle();
      },
    },
  };
  return treeKeyContext(base, tree, overview.model);
}

function useProjectViews(tabs: Tabs) {
  const tree = useTreeMode(tabs);
  const overview = useOverviewMode(
    tabs.pane.path,
    tabs.showHidden,
    tabs.openAt,
    tabs.reveal,
    tabs.navigate,
    tree.root,
    { tab: tree.id, reveal: tree.reveal, exit: tree.close },
  );
  return { tree, overview };
}

function browsingFlash(
  context: KeyContext,
  tree: ReturnType<typeof useTreeMode>,
  overview: ReturnType<typeof useOverviewMode>,
  miller: ReturnType<typeof useFlash>,
) {
  if (context.view === "tree")
    return { active: tree.flashActive, onKey: tree.onFlashKey, chrome: null };
  if (context.view === "overview")
    return { active: overview.flashActive, onKey: overview.onFlashKey, chrome: null };
  return miller;
}
