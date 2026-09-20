import type { EntrySummary } from "../entry.ts";
import { classify, inheritsFrom, isImageMime, type MimeTables } from "../mime.ts";

/**
 * One decision tree for what to show, shared by every consumer.
 *
 * The Qt original had exactly one router used by both the Miller pane and the
 * finder's info pane, and the rule that kept it honest was: a preview type
 * added here appears in both, and NO consumer re-implements the routing. The
 * same rule holds here.
 *
 * ── The branch order is a contract ──────────────────────────────────────────
 * none → directory → image → document → video → audio → spreadsheet →
 * archive → code → text → fallback.
 *
 * Video before audio matters for the same reason: a Matroska carrying only an
 * audio track resolves to `video/x-matroska`, and routing it as audio would
 * hide a file the video element handles perfectly well.
 *
 * Image before text is the one that bites. `image/svg+xml` inherits from
 * `application/xml`, which inherits from `text/plain`, so an SVG *is* text
 * under the inheritance rules — test text first and every SVG previews as
 * source. `route.test.ts` pins that with an SVG.
 */

/** What the router is handed. Everything it needs, and nothing it must fetch. */
export interface PreviewTarget {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  /** How many entries a directory holds. Meaningless for a file. */
  readonly entryCount: number;
  /** The first entries, capped by whoever read them. Empty for a file. */
  readonly entries: readonly EntrySummary[];
  readonly size: number;
  readonly mime: string | null;
  /** The first bytes, for the sniff that catches an unregistered text file. */
  readonly head: Uint8Array;
}

/** A branch the shape keeps but this cycle does not build. */
export type UnbuiltKind = "archive";

/** Which reader can open this archive. */
export type ArchiveFormat = "zip" | "tar";

/** What the bytes have to go through before the reader sees them. */
export type ArchiveCompression = "none" | "gzip";

export type PreviewRoute =
  /** Nothing under the cursor. */
  | { readonly kind: "none" }
  /**
   * `entries` is what the column draws; `entryCount` is the whole truth.
   *
   * They differ when the listing was capped, and that difference is the only
   * thing that lets the pane say how many it is not showing.
   */
  | {
      readonly kind: "directory";
      readonly entryCount: number;
      readonly entries: readonly EntrySummary[];
    }
  | { readonly kind: "image"; readonly mime: string }
  | { readonly kind: "document"; readonly mime: string }
  /** Played by the browser itself: silent, looping, at its own aspect ratio. */
  | { readonly kind: "video"; readonly mime: string }
  /** Cover art, tags and a transport. Never plays on its own. */
  | { readonly kind: "audio"; readonly mime: string }
  /** A grid, with a tab per sheet. Also where a csv goes. */
  | { readonly kind: "spreadsheet"; readonly mime: string }
  /**
   * An archive one of the two readers can list.
   *
   * `format` says which reader; `compression` says what to pipe the bytes
   * through first. They are separate because a `.tar` and a `.tar.gz` are the
   * same format read differently, and folding them into one name would make
   * the pane re-derive from the MIME type what the router already decided.
   */
  | {
      readonly kind: "archive";
      readonly mime: string;
      readonly format: ArchiveFormat;
      readonly compression: ArchiveCompression;
    }
  | { readonly kind: "code"; readonly language: string }
  | { readonly kind: "text" }
  /** The branch exists and says so, rather than falling through to garbage. */
  | { readonly kind: "unbuilt"; readonly what: UnbuiltKind; readonly mime: string }
  /** A binary with no branch of its own: name, size, type. */
  | { readonly kind: "fallback"; readonly mime: string | null };

/**
 * Extension to `highlight.js` language, explicitly.
 *
 * **Never call automatic language detection.** It was measured at 35 times the
 * explicit cost and it misidentified JavaScript as a DNS zone file. An
 * extension that is not here renders as plain text, which is a correct answer;
 * a guess that is wrong is not.
 */
const LANGUAGES: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json", "json"],
  ["jsonc", "json"],
  ["py", "python"],
  ["rs", "rust"],
  ["go", "go"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["hxx", "cpp"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["rb", "ruby"],
  ["php", "php"],
  ["cs", "csharp"],
  ["swift", "swift"],
  ["lua", "lua"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["fish", "bash"],
  ["ps1", "powershell"],
  ["sql", "sql"],
  ["html", "xml"],
  ["xhtml", "xml"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["css", "css"],
  ["scss", "scss"],
  ["less", "less"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["toml", "ini"],
  ["ini", "ini"],
  ["conf", "ini"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["qml", "qml"],
  ["cmake", "cmake"],
  ["dockerfile", "dockerfile"],
  ["diff", "diff"],
  ["patch", "diff"],
  ["vim", "vim"],
  ["nix", "nix"],
]);

/** A file with a second presentation, beside its source. */
export type RenderableAs = "markdown" | "html";

/**
 * Extensions that carry a rendered form.
 *
 * Separate from `LANGUAGES` above even though both are keyed on an extension,
 * because they answer different questions and drift apart the moment a third
 * renderable format arrives: `LANGUAGES` says how to COLOUR the source, and
 * this says whether there is anything to show instead of the source.
 */
const RENDERABLE_EXTENSIONS: ReadonlyMap<string, RenderableAs> = new Map([
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["html", "html"],
  ["xhtml", "html"],
]);

/** Types that carry a rendered form, for a file whose name does not say. */
const RENDERABLE_TYPES: ReadonlyMap<string, RenderableAs> = new Map([
  ["text/markdown", "markdown"],
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
]);

/**
 * Whether this file can be shown rendered, and as what.
 *
 * **Deliberately not a member of `PreviewRoute` and not an argument to
 * `routePreview`.** The route union is a decision tree over what KIND of thing
 * a file is; whether that kind has a second presentation is a separate fact,
 * and folding it in would make every consumer test a discriminant before
 * reading a field only some members carry. Adding the MODE as an argument
 * would be worse still: the router is shared precisely because it holds no
 * interface state.
 *
 * **One function, two callers**, and that is the point of it existing at all.
 * The preview hook calls it because it holds the name and the resolved type;
 * the keybinding table calls it from a `when()` gate because a cursor entry
 * holds both as well. The alternative — a MIME list in each — is the shape
 * that cost the previous cycle a release, when the panel's hand-written table
 * and the system database disagreed about compressed tarballs while every test
 * passed.
 *
 * The name decides first and the type is the fallback. A `.md` served as
 * `text/plain` is still markdown, because the user chose the name and the
 * database guessed; a README with no extension is still markdown when the
 * database says so, because there the name says nothing at all.
 */
export function renderableAs(name: string, mime: string | null): RenderableAs | null {
  const lower = name.toLowerCase();

  // `dot > 0`, matching `languageFor`: a leading dot makes a NAME, not an
  // extension, so a file called exactly `.md` is a dotfile and not markdown.
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const byExtension = RENDERABLE_EXTENSIONS.get(lower.slice(dot + 1));
    if (byExtension !== undefined) return byExtension;
  }

  return mime === null ? null : (RENDERABLE_TYPES.get(mime) ?? null);
}

/**
 * Files that carry a language but no extension.
 *
 * Matched on the whole name, lowercased. A `Makefile` is not `*.mk`.
 */
const BY_NAME: ReadonlyMap<string, string> = new Map([
  ["makefile", "makefile"],
  ["dockerfile", "dockerfile"],
  ["cmakelists.txt", "cmake"],
  ["pkgbuild", "bash"],
  [".bashrc", "bash"],
  [".zshrc", "bash"],
  [".gitconfig", "ini"],
  [".editorconfig", "ini"],
]);

/** The `highlight.js` language for a filename, or `null` for none. */
export function languageFor(name: string): string | null {
  const lower = name.toLowerCase();

  const byName = BY_NAME.get(lower);
  if (byName !== undefined) return byName;

  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;

  return LANGUAGES.get(lower.slice(dot + 1)) ?? null;
}

/** Types Chromium's own viewer renders better than anything we would write. */
function isDocument(tables: MimeTables, mime: string): boolean {
  return mime === "application/pdf" || inheritsFrom(tables, mime, "application/pdf");
}

/** Is `mime` this type, or a descendant of it? */
function isOrInherits(tables: MimeTables, mime: string, root: string): boolean {
  return mime === root || inheritsFrom(tables, mime, root);
}

const SPREADSHEETS: readonly string[] = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
];

function isSpreadsheet(mime: string): boolean {
  return SPREADSHEETS.includes(mime);
}

/**
 * The archives a reader can open, and how.
 *
 * ── The order is the contract, and it comes from the MIME database ──────────
 * `/usr/share/mime/subclasses` says `application/x-compressed-tar` inherits
 * from `application/gzip` and NOT from `application/x-tar` — a `.tar.gz` is a
 * gzip as far as the database is concerned. So the gzip branch is what catches
 * a tarball, and the tar branch catches only a bare `.tar`.
 *
 * Zip goes first because a great many things inherit from it. `.docx`, `.odt`,
 * `.epub` and `.jar` are all subclasses of `application/zip`, so THIS FUNCTION
 * lists them as archives — they are zips, and showing what is inside one beats
 * a notice saying nothing can be shown. A `.xlsx` is a subclass too and never
 * reaches this branch, because the spreadsheet test runs first.
 *
 * **The running panel does not see those edges yet**, and this comment used to
 * imply it did. `packages/fm-ui/src/usePreview.ts` hands this router a small
 * hand-written table rather than the system database, and no zip subclass is in
 * it — so a `.jar` shows the generic fallback in the application while passing
 * every test here. Read that file's header before trusting this paragraph.
 */
const READABLE_ARCHIVES: readonly {
  readonly root: string;
  readonly format: ArchiveFormat;
  readonly compression: ArchiveCompression;
}[] = [
  { root: "application/zip", format: "zip", compression: "none" },
  { root: "application/x-tar", format: "tar", compression: "none" },
  { root: "application/gzip", format: "tar", compression: "gzip" },
];

/**
 * The archives nothing here can open.
 *
 * 7z and rar have no reader in this language; xz, bzip2 and zstd have no
 * decompressor in the browser. Each compressed tar reaches this list through
 * its own compressor — `application/x-xz-compressed-tar` inherits from
 * `application/x-xz` — so naming the compressors covers the tarballs too.
 */
const UNREADABLE_ARCHIVE_ROOTS: readonly string[] = [
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-xz",
  "application/zstd",
  "application/x-bzip2",
];

function archiveRoute(tables: MimeTables, mime: string): PreviewRoute | null {
  for (const { root, format, compression } of READABLE_ARCHIVES) {
    if (isOrInherits(tables, mime, root)) return { kind: "archive", mime, format, compression };
  }
  return null;
}

function unreadableArchive(tables: MimeTables, mime: string): boolean {
  return UNREADABLE_ARCHIVE_ROOTS.some((root) => isOrInherits(tables, mime, root));
}

/**
 * Everything decidable from the MIME type alone, in the order that matters.
 *
 * Split out of `routePreview` because the two halves answer different
 * questions: this one asks what KIND of thing the file is, while what remains
 * there asks what to do when the type did not settle it. The complexity gate
 * is what forced the seam, and it fell in a reasonable place.
 *
 * **The order here is the contract** documented at the top of this file. Every
 * one of these runs before the content classification, and each has a reason:
 * an SVG is text, a csv is text, and both would route wrongly the other way
 * round.
 */
function routeByType(tables: MimeTables, mime: string): PreviewRoute | null {
  // Before text, always. See the branch-order note above.
  if (isImageMime(tables, mime)) return { kind: "image", mime };
  if (isDocument(tables, mime)) return { kind: "document", mime };

  // Routing is by type; whether these particular bytes decode is decided at the
  // element, which is the only place that can know.
  if (mime.startsWith("video/")) return { kind: "video", mime };
  // After video, deliberately: a Matroska carrying only an audio track is still
  // a `video/` type to the database, and the element decides what it can do.
  if (mime.startsWith("audio/")) return { kind: "audio", mime };

  // Before the archive branch, deliberately: a `.xlsx` is a subclass of
  // `application/zip`, so it would otherwise list as an archive. And before the
  // text classification, because a csv IS text and routing it as such would
  // trade a grid for a wall of commas.
  if (isSpreadsheet(mime)) return { kind: "spreadsheet", mime };

  // Readable first: an unreadable root can never also be a readable one, but
  // stating the order means a format that gains a reader later is a one-line
  // move between the two lists rather than a rethink.
  const archive = archiveRoute(tables, mime);
  if (archive !== null) return archive;
  if (unreadableArchive(tables, mime)) return { kind: "unbuilt", what: "archive", mime };

  return null;
}

/**
 * Decide what to show for one entry.
 *
 * Pure, so the whole decision tree is testable without a window and without a
 * filesystem: every branch is reachable from a constructed target.
 */
export function routePreview(tables: MimeTables, target: PreviewTarget | null): PreviewRoute {
  if (target === null) return { kind: "none" };
  if (target.isDirectory) {
    return { kind: "directory", entryCount: target.entryCount, entries: target.entries };
  }

  const mime = target.mime;

  const byType = mime === null ? null : routeByType(tables, mime);
  if (byType !== null) return byType;

  // `classify` carries the content sniff, which is what makes an extensionless
  // config file preview as text instead of as bytes.
  if (classify(tables, mime, target.head) !== "text") return { kind: "fallback", mime };

  const language = languageFor(target.name);
  return language === null ? { kind: "text" } : { kind: "code", language };
}
