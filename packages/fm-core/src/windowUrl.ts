/**
 * What the window URL carries, written and read from one place.
 *
 * Two facts travel on it and they are deliberately different:
 *
 * - the **fragment** is where this window OPENS;
 * - the **query** is where HOME is, which is where the tilde goes.
 *
 * They hold the same value today only because nothing opens a window anywhere
 * else yet. The first thing that does would otherwise silently redefine the
 * tilde as "back to where this window started", which is not what it says.
 *
 * Both halves live here because they are two ends of one agreement between two
 * processes that cannot import each other. The main process builds the URL and
 * the sandboxed renderer reads it, so a typo in the parameter name on either
 * side would break the tilde with nothing to catch it — the failure is a key
 * that is simply absent, which reads exactly like a window with no home. One
 * string, used by both, removes the possibility rather than testing for it.
 *
 * **`URLSearchParams` is not used, for two reasons and both matter.** This
 * package compiles against no environment at all — no DOM and no Node — so the
 * global is not in scope here, which is the same rule that keeps a `window`
 * reference out of the main process. And it would be wrong even where it is
 * available: its parser is the HTML form encoding, which decodes `+` to a
 * space, so a directory named `c++` would come back as `c  `. A pair of
 * `encodeURIComponent` and `decodeURIComponent` round-trips every byte.
 */

/** The query parameter's name. Never written out anywhere else. */
const HOME_PARAM = "home";

/** The query string the main process appends, including its leading `?`. */
export function homeQuery(home: string): string {
  return `?${HOME_PARAM}=${encodeURIComponent(home)}`;
}

/** One parameter's raw value, or null when the query does not carry it. */
function rawParam(search: string, name: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 0 || pair.slice(0, equals) !== name) continue;
    return pair.slice(equals + 1);
  }
  return null;
}

/**
 * The home directory a window was told about, or `/`.
 *
 * The fallback is the same one the fragment reader uses for a malformed value:
 * a window that cannot tell where home is stays usable, and the tilde goes
 * somewhere real rather than throwing or doing nothing. Three things reach it —
 * no query at all, a query without this parameter, and a value that is not an
 * absolute path.
 */
export function homeFromSearch(search: string): string {
  const raw = rawParam(search, HOME_PARAM);
  if (raw === null) return "/";

  const value = decodeOrEmpty(raw);
  return value.startsWith("/") ? value : "/";
}

/**
 * Decode, or give up.
 *
 * `decodeURIComponent` THROWS on a malformed escape — `%zz`, or a bare `%` at
 * the end. Nothing in this application produces one, and a URL is external
 * input the moment anything else can set it, so a throw here would take the
 * whole render down over a stray character.
 */
function decodeOrEmpty(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** The query parameter carrying a picker request. Never written out elsewhere. */
const PICKER_PARAM = "picker";

/**
 * The request a picker window is opened for, as it travels on that window's URL.
 *
 * On the URL rather than over the bridge, and the reason is what the user sees:
 * the renderer needs this at FIRST RENDER. A dialog that paints as an ordinary
 * browse window and only then becomes a picker is a visible flicker, and a
 * request across the bridge arrives a frame or two late by construction.
 *
 * `homeQuery` established the mechanism and this follows it exactly, including
 * the part that looks like an omission: `encodeURIComponent` rather than
 * `URLSearchParams`, because this package compiles against no environment at all
 * and because that parser is the HTML form encoding, which decodes `+` as a
 * space — so a directory named `c++` would come back as `c  `.
 */
export interface PickerWindowRequest {
  readonly fifo: string;
  readonly options: {
    readonly title: string;
    readonly acceptLabel: string;
    readonly multiple: boolean;
    readonly directory: boolean;
    readonly saveMode: boolean;
    readonly suggestedName: string;
    readonly currentFolder: string;
  };
}

export function pickerQuery(request: PickerWindowRequest): string {
  return `?${PICKER_PARAM}=${encodeURIComponent(JSON.stringify(request))}`;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * The picker request this window was opened for, or null for a browse window.
 *
 * **Null rather than a defaulted object on every failure**, and that is the
 * important half: a browse window carries no picker parameter, and a request
 * that came back malformed must not be mistaken for a dialog with every option
 * defaulted. It never throws — a URL is external input the moment anything else
 * can set it, and a throw here would take the whole render down over a stray
 * character.
 *
 * The shape is re-checked rather than trusted. The main process wrote it and the
 * value is not attacker-controlled today, but a reader that assumed the shape
 * would turn a future mistake into a crash inside React's render.
 */
export function pickerFromSearch(search: string): PickerWindowRequest | null {
  const raw = rawParam(search, PICKER_PARAM);
  if (raw === null) return null;

  const decoded = decodeOrEmpty(raw);
  if (decoded === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // SAFETY: proven a non-null, non-array object on the line above, and both
  // fields are declared optional and `unknown` — so this claims only that the
  // keys may be read, and the checks below establish what they hold.
  const { fifo, options } = parsed as { fifo?: unknown; options?: unknown };
  if (!isText(fifo)) return null;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return null;

  // SAFETY: proven a non-null, non-array object on the line above.
  const o = options as Record<string, unknown>;
  if (!isText(o.title) || !isText(o.acceptLabel) || !isText(o.suggestedName)) return null;
  if (!isText(o.currentFolder)) return null;
  if (!isFlag(o.multiple) || !isFlag(o.directory) || !isFlag(o.saveMode)) return null;

  return {
    fifo,
    options: {
      title: o.title,
      acceptLabel: o.acceptLabel,
      multiple: o.multiple,
      directory: o.directory,
      saveMode: o.saveMode,
      suggestedName: o.suggestedName,
      currentFolder: o.currentFolder,
    },
  };
}
