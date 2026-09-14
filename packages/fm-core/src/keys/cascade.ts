import { handleBookmarkSubMode, resolveChord } from "./chords.ts";
import { dispatch, matchBinding } from "./dispatch.ts";
import type { Binding, BookmarkSubMode, KeyContext, KeyEvent } from "./types.ts";

/**
 * The imperative cascade that runs before the registry.
 *
 * **These are modes, not bindings, and that is why they are not rows.** A row
 * answers "what does this key do"; a mode answers "who owns the keyboard right
 * now". Folding a mode into the table would make its precedence a matter of
 * array order, which is exactly the drift the table was built to remove.
 *
 * The order is load-bearing in one specific place: **chord resolution must run
 * before `dispatch`**, because `dispatch` begins with the picker suppression
 * pre-pass. A chord ending in a suppressed letter — `cd` inside a file
 * chooser — would otherwise be eaten before the resolver ever saw it.
 */

/** Who currently owns the keyboard. */
export interface CascadeMode {
  readonly modalOpen: boolean;
  readonly bookmarkSubMode: BookmarkSubMode | null;
  /** `""` when no chord is pending. */
  readonly chordPrefix: string;
  readonly flashActive: boolean;
  /**
   * True when a text input holds focus — the search field, a rename field.
   *
   * **This is not a cascade step, and the project documentation was wrong to
   * list it as one.** Whether search receives a key is decided by FOCUS: the
   * input has it, so the key never reaches this function. It appears here only
   * so a host that routes every key through one place can say so explicitly and
   * get the honest answer, which is "not mine".
   */
  readonly textInputFocused: boolean;
}

/**
 * What happened to a key.
 *
 * A decision, not an effect, for the modes this package does not own. Flash
 * navigation is a text-input mode whose handler lives in the host; returning
 * `"flash"` hands it over without this package needing to know how it works.
 */
export type KeyOutcome =
  /** A text input owns the keyboard. Let the key reach it. */
  | { readonly kind: "notOurs" }
  /** A modal is open and swallows everything. */
  | { readonly kind: "modal" }
  /** Hand this key to the host's flash handler. */
  | { readonly kind: "flash" }
  | { readonly kind: "bookmark" }
  | { readonly kind: "chord"; readonly cancelled: boolean }
  /** Claimed by picker suppression before any binding could see it. */
  | { readonly kind: "picker" }
  | { readonly kind: "dispatched"; readonly binding: Binding }
  /** Scanned and claimed by nothing. The key falls through. */
  | { readonly kind: "unhandled" };

/**
 * Route one key press.
 *
 * ── The Escape order, corrected ─────────────────────────────────────────────
 * The project documentation describes it as "chord, search, flash, picker,
 * close window". That omits two steps and misplaces search. What actually
 * happens, and what this implements, is:
 *
 *   1. A text input has focus       → the input handles Escape. Never reaches here.
 *   2. A modal is open              → the modal handles it.
 *   3. The bookmark sub-mode is on  → cancels the sub-mode.
 *   4. A chord is pending           → cancels the chord.
 *   5. Flash is active              → the flash handler cancels it.
 *   6. A picker is open             → clears the selection, else cancels the picker.
 *   7. Something is selected        → clears the selection (`sel.clear`).
 *   8. Miller view                  → swallowed (`miller.escapeSwallow`).
 *      Tree view                    → falls through, so the host can close.
 *
 * Steps 6 to 8 are inside `dispatch`; the rest are here.
 */
export function handleKey(event: KeyEvent, mode: CascadeMode, ctx: KeyContext): KeyOutcome {
  if (mode.textInputFocused) return { kind: "notOurs" };
  if (mode.modalOpen) return { kind: "modal" };

  if (mode.bookmarkSubMode !== null) {
    handleBookmarkSubMode(mode.bookmarkSubMode, event, ctx);
    return { kind: "bookmark" };
  }

  // Before `dispatch`, always. See the module comment.
  if (mode.chordPrefix !== "") {
    const result = resolveChord(mode.chordPrefix, event, ctx);
    return { kind: "chord", cancelled: result.cancelled };
  }

  if (mode.flashActive) return { kind: "flash" };

  // `matchBinding` first so the outcome can name what ran. The picker pre-pass
  // inside `dispatch` may still claim the key before any binding does, which is
  // why the result is checked rather than assumed.
  const binding = matchBinding(event, ctx);
  const consumed = dispatch(event, ctx);

  if (!consumed) return { kind: "unhandled" };
  // Consumed with nothing matched means the picker pre-pass claimed it.
  return binding === null ? { kind: "picker" } : { kind: "dispatched", binding };
}
