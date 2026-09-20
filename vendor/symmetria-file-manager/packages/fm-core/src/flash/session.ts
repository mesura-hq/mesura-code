import { computeFlash, type FlashLabelling, type FlashMatch } from "./labels.ts";

/**
 * A running flash session, and what each key does to it.
 *
 * The port of `FlashHandler.handleKey` from the Qt build, turned inside out. Qt
 * writes into `WindowState` as it goes and moves the cursor itself; here every
 * branch **reports** what should happen and the host applies it. That is what
 * lets the whole key table be exercised without a window, and it is why
 * restoring the cursor on a cancellation is not this module's business — the
 * host is the only thing that knows where the cursor was.
 *
 * **There is no timer, and there must not be one.** The project documentation
 * claimed a 500 ms chord timeout twice; the Qt source has never had one. A
 * pending label waits for the next key, however long that takes.
 */

export interface FlashState {
  /** What has been typed so far, lowercased. */
  readonly query: string;
  /** The first character of a two-character label, waiting for its second. */
  readonly pendingLabel: string;
  /** The matches and the labels for `query`, as the engine last computed them. */
  readonly labelling: FlashLabelling;
}

/**
 * The part of a key press this module reads.
 *
 * Named rather than written inline at the signature, so the host that builds
 * one has something to import instead of matching a shape structurally.
 */
export interface FlashKeyEvent {
  readonly key: string;
}

/** What a key means. A decision; the host performs it. */
export type FlashOutcome =
  /** Carry on with this state. The same object when nothing changed. */
  | { readonly kind: "state"; readonly state: FlashState }
  /** Go here, and end the session. */
  | { readonly kind: "jump"; readonly match: FlashMatch }
  /** End the session, putting the cursor back where it started. */
  | { readonly kind: "cancel" };

/**
 * A session that has just started: nothing typed, nothing labelled.
 *
 * The empty labelling comes from the engine rather than from a literal here. An
 * empty query labels nothing whatever the candidates are, so asking is both
 * correct and cheaper than a second definition of "nothing" that could drift —
 * and it is a fresh one per session, which the shared-constant version of this
 * in the engine turned out not to be.
 */
export function newFlashState(): FlashState {
  return { query: "", pendingLabel: "", labelling: computeFlash("", [], 0) };
}

/**
 * Keys that arrive on their own while a modifier is held down.
 *
 * Swallowed rather than dropped through, so holding Shift to type a capital
 * does not first look like a character that means nothing.
 */
const BARE_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Carry on with a new query, relabelling for it. Any pending label is void. */
function retyped(query: string, relabel: (query: string) => FlashLabelling): FlashOutcome {
  return { kind: "state", state: { query, pendingLabel: "", labelling: relabel(query) } };
}

/** Carry on with this exact state. Nothing was rebuilt and nothing relabelled. */
function unchanged(state: FlashState): FlashOutcome {
  return { kind: "state", state };
}

/**
 * Backspace: withdraw the half-typed label, else a character, else the session.
 *
 * A held label goes first and the query is untouched — the user is taking back
 * the label they started, not the search that found it.
 */
function onBackspace(state: FlashState, relabel: (query: string) => FlashLabelling): FlashOutcome {
  if (state.pendingLabel !== "") return { kind: "state", state: { ...state, pendingLabel: "" } };
  if (state.query === "") return { kind: "cancel" };
  return retyped(state.query.slice(0, -1), relabel);
}

/**
 * The second character of a two-character label.
 *
 * A pair that exists jumps; one that does not is dropped rather than guessed
 * at, and either way what was held is released.
 */
function onPendingLabel(state: FlashState, char: string): FlashOutcome {
  const completed = state.labelling.matches.find(
    (match) => match.label === state.pendingLabel + char,
  );
  if (completed !== undefined) return { kind: "jump", match: completed };
  return { kind: "state", state: { ...state, pendingLabel: "" } };
}

/**
 * A character that is part of some label: jump, or hold it as a prefix.
 *
 * `null` means it is not a label at all, and the caller should read it as a
 * search instead. A single-character label is checked FIRST — it resolves on
 * the keystroke, which is exactly why the engine never lets a pair start with
 * one.
 */
function onLabelChar(state: FlashState, char: string): FlashOutcome | null {
  if (!state.labelling.labelChars.has(char)) return null;

  const exact = state.labelling.matches.find((match) => match.label === char);
  if (exact !== undefined) return { kind: "jump", match: exact };

  const startsAPair = state.labelling.matches.some(
    (match) => match.label.length === 2 && match.label.startsWith(char),
  );
  return startsAPair ? { kind: "state", state: { ...state, pendingLabel: char } } : null;
}

/**
 * Decide what one key does to a session.
 *
 * `relabel` is a parameter rather than a call this module makes, because the
 * candidate list belongs to the host — it changes as the columns scroll and as
 * the previewed directory settles — so the engine cannot be reached from here
 * with anything true.
 *
 * ── The branch order IS the specification ──────────────────────────────────
 * Taken from `FlashHandler.js` lines 16 to 125 and kept in its order, because
 * the order is what decides the ambiguous cases: a pending label claims the
 * next key before any label or continuation is considered, and a label claims
 * it before the query can grow. The branches are named functions rather than
 * inline blocks so that order is the only thing left to read here.
 */
export function flashKey(
  state: FlashState,
  key: FlashKeyEvent,
  relabel: (query: string) => FlashLabelling,
): FlashOutcome {
  if (BARE_MODIFIERS.has(key.key)) return unchanged(state);
  if (key.key === "Escape") return { kind: "cancel" };
  if (key.key === "Backspace") return onBackspace(state, relabel);

  // Anything the browser reports under a name rather than as a character —
  // a function key, an arrow, Tab. This is the DOM's equivalent of the
  // `event.text === ""` test the Qt version uses.
  //
  // Counted by CODE POINT and not by `.length`. A character outside the basic
  // plane — an emoji from a compose key or an input method — arrives as a
  // surrogate pair, so `.length` reports 2 and the plain test would swallow a
  // character Qt lets through. It cannot be a label, but it can be part of a
  // name somebody is searching for.
  if ([...key.key].length !== 1) return unchanged(state);
  const char = key.key.toLowerCase();

  if (state.pendingLabel !== "") return onPendingLabel(state, char);

  const asLabel = onLabelChar(state, char);
  if (asLabel !== null) return asLabel;

  // An empty query has no labels and no continuations yet, so the first
  // character typed is always a search and never a jump.
  if (state.query === "" || state.labelling.continuations.has(char)) {
    return retyped(state.query + char, relabel);
  }

  // Neither a label nor a way to continue. It means nothing here.
  return unchanged(state);
}
