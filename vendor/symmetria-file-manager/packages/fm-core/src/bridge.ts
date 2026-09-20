import type { Result } from "@symmetria/fm-core/contract";

/**
 * The single global the sandboxed renderer is allowed to see.
 *
 * One name, one object. Every capability the interface needs arrives through
 * it, which keeps the surface auditable: counting the ways into the privileged
 * half is counting the keys on this object.
 */
export const BRIDGE_KEY = "symmetriaFm";

/** An unsubscribe function, returned by every listener registration. */
export type Unsubscribe = () => void;

export interface Bridge {
  /** Identifies which build produced this bridge. */
  readonly version: string;
  /** List a directory. Failures arrive as values, never as thrown errors. */
  overview(request: unknown): Promise<Result<unknown>>;
  list(request: unknown): Promise<Result<unknown>>;
  /** Start watching a directory for changes. */
  watch(request: unknown): Promise<Result<unknown>>;
  /** Stop watching. */
  unwatch(request: unknown): Promise<Result<unknown>>;
  /** Read the head of a text file. */
  readText(request: unknown): Promise<Result<unknown>>;
  /** Abandon an in-flight listing. */
  cancel(request: unknown): Promise<Result<unknown>>;
  /** Open a search index over a directory. */
  searchStart(request: unknown): Promise<Result<unknown>>;
  /** Search an open index. */
  searchQuery(request: unknown): Promise<Result<unknown>>;
  /** Attribute a chosen file to the query that found it. */
  searchRecord(request: unknown): Promise<Result<unknown>>;
  /** Release a search index. */
  searchRelease(request: unknown): Promise<Result<unknown>>;
  /** Everything the preview router needs about one entry. */
  describe(request: unknown): Promise<Result<unknown>>;
  /** Make one file loadable by the renderer, and name the URL. */
  previewUrl(request: unknown): Promise<Result<unknown>>;
  /** Make a file's own directory loadable, and name the URL it roots. */
  previewDirectoryUrl(request: unknown): Promise<Result<unknown>>;
  /** Copy or move entries into a directory. */
  transfer(request: unknown): Promise<Result<unknown>>;
  /** Abandon a running transfer. */
  cancelTransfer(request: unknown): Promise<Result<unknown>>;
  /** Create an empty file or a directory, with its parents. */
  create(request: unknown): Promise<Result<unknown>>;
  /** Rename an entry in place. */
  rename(request: unknown): Promise<Result<unknown>>;
  /** Send entries to the desktop trash. */
  trash(request: unknown): Promise<Result<unknown>>;
  /** Hand an entry to whatever the desktop says opens it. */
  open(request: unknown): Promise<Result<unknown>>;
  /** Put text or an image on the system clipboard. */
  clipboard(request: unknown): Promise<Result<unknown>>;
  /** The directories zoxide records this user going to. */
  frecent(request: unknown): Promise<Result<unknown>>;
  /** Read the bookmark store, seeding it on a first run. */
  bookmarksRead(request: unknown): Promise<Result<unknown>>;
  /** Replace the bookmark store. */
  bookmarksWrite(request: unknown): Promise<Result<unknown>>;
  /** Read the stored listing order. Answers the default on a first run. */
  listingRead(request: unknown): Promise<Result<unknown>>;
  /** Replace the stored listing order. */
  listingWrite(request: unknown): Promise<Result<unknown>>;
  /** Put the window away, keeping the program and its state alive. */
  hideWindow(request: unknown): Promise<Result<unknown>>;
  /**
   * Answer the caller this dialog was opened for.
   *
   * The renderer cannot write a named pipe and must not try — it is sandboxed
   * with no filesystem at all. It says WHAT was chosen; the main process owns
   * the pipe, the exactly-once rule and the expiry.
   */
  pickerConfirm(request: unknown): Promise<Result<unknown>>;
  pickerCancel(request: unknown): Promise<Result<unknown>>;
  /** Follow a running transfer. */
  onTransferProgress(listener: (event: unknown) => void): Unsubscribe;
  /** Receive one batch of a streamed listing. */
  onListBatch(listener: (batch: unknown) => void): Unsubscribe;
  /** Receive a directory-changed notification. */
  onChanged(listener: (event: unknown) => void): Unsubscribe;
  /** Receive a path the daemon was asked, from outside, to open. */
  onOpenPath(listener: (event: unknown) => void): Unsubscribe;
}
