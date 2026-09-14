/**
 * Every channel, in one place, split by direction.
 *
 * The split is not decoration. A request channel gets a handler and returns a
 * reply; a push channel is sent to and never handled. Keeping them in one flat
 * map made a test asserting "every channel has a handler" fail for a correct
 * implementation, which is a sign the map was hiding a real distinction.
 *
 * One prefix throughout, so a channel that does not belong to this application
 * is obvious at a glance and the whole surface is assertable.
 */

/** Renderer asks, main process replies. Each one has exactly one handler. */
export const REQUEST_CHANNELS = {
  overview: "symmetria-fm:overview",
  /** List a directory. */
  list: "symmetria-fm:list",
  /** Start watching a directory. */
  watch: "symmetria-fm:watch",
  /** Stop watching. */
  unwatch: "symmetria-fm:unwatch",
  /** Read the head of a text file. */
  readText: "symmetria-fm:read-text",
  /** Abandon an in-flight stream. */
  cancel: "symmetria-fm:cancel",
  /** Everything the preview router needs about one entry. */
  describe: "symmetria-fm:describe",
  /** Make one file loadable by the renderer, and name the URL. */
  previewUrl: "symmetria-fm:preview-url",
  /**
   * Make a previewed file's own directory loadable, and name the URL it roots.
   *
   * For a rendered document reaching its own images and stylesheet. Separate
   * from `previewUrl` because the grant it issues is a different, stronger
   * thing: that one names one file and narrows nothing, this one names a root
   * and refuses everything outside it.
   */
  previewDirectoryUrl: "symmetria-fm:preview-directory-url",
  /** Copy or move entries into a directory. */
  transfer: "symmetria-fm:transfer",
  /** Abandon a running transfer. */
  cancelTransfer: "symmetria-fm:cancel-transfer",
  /** Create an empty file or a directory, with its parents. */
  create: "symmetria-fm:create",
  /** Rename an entry in place. */
  rename: "symmetria-fm:rename",
  /** Send entries to the desktop trash. */
  trash: "symmetria-fm:trash",
  /** The directories zoxide records this user going to. */
  frecent: "symmetria-fm:frecent",
  /**
   * Open a search index over a directory.
   *
   * Four channels rather than one, because an index has a LIFETIME. Folding
   * "open" into "search" would make the first keystroke of every session pay
   * for a full scan with no way to say so, and would leave nothing able to say
   * when the index is no longer wanted.
   */
  searchStart: "symmetria-fm:search-start",
  /** Search an open index. */
  searchQuery: "symmetria-fm:search-query",
  /**
   * Attribute a chosen file to the query that found it.
   *
   * Its own channel rather than a flag on the search, because it happens once
   * per session at the moment the overlay closes, and folding it into the
   * query would make every keystroke carry a field only the last one uses.
   */
  searchRecord: "symmetria-fm:search-record",
  /** Release an index now, rather than waiting for it to go idle. */
  searchRelease: "symmetria-fm:search-release",
  /** Put text or an image on the system clipboard. */
  clipboard: "symmetria-fm:clipboard",
  /** Hand an entry to whatever the desktop says opens it. */
  open: "symmetria-fm:open",
  /** Read the bookmark store, seeding it on a first run. */
  bookmarksRead: "symmetria-fm:bookmarks-read",
  /** Replace the bookmark store. */
  bookmarksWrite: "symmetria-fm:bookmarks-write",
  /** Read the stored listing order. Answers the default on a first run. */
  listingRead: "symmetria-fm:listing-read",
  /** Replace the stored listing order. */
  listingWrite: "symmetria-fm:listing-write",
  /**
   * Put the window away without ending the program.
   *
   * The renderer cannot do this for itself, and must not try. Page code calling
   * `window.close()` DESTROYS the window without ever raising the window's own
   * `close` event — measured on Electron 41 — so the main process cannot
   * intercept it and every tab, cursor and scroll position goes with it.
   */
  hideWindow: "symmetria-fm:hide-window",
  /**
   * The user chose. Answer the caller waiting on this dialog's pipe.
   *
   * A HOST channel, like `hideWindow`: the registry is the privileged
   * filesystem half and becomes an importable package, and answering a desktop
   * portal is the one thing an embedding editor would never satisfy.
   */
  pickerConfirm: "symmetria-fm:picker-confirm",
  /** The user cancelled, or the dialog is being dismissed. */
  pickerCancel: "symmetria-fm:picker-cancel",
} as const;

/** Main process pushes, renderer listens. These are never handled. */
export const PUSH_CHANNELS = {
  /** One batch of a streamed listing. */
  listBatch: "symmetria-fm:list-batch",
  /** A watched directory changed. */
  changed: "symmetria-fm:changed",
  /** How far a transfer has got. */
  transferProgress: "symmetria-fm:transfer-progress",
  /**
   * Somebody asked the daemon to open a path.
   *
   * A push and not a request, because the origin is outside both processes: the
   * command arrives on the socket from another program entirely, and the
   * renderer is being told rather than answering.
   */
  openPath: "symmetria-fm:open-path",
} as const;

export const CHANNELS = { ...REQUEST_CHANNELS, ...PUSH_CHANNELS } as const;
