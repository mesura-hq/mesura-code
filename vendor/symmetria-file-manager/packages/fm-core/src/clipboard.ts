import type { CopyTarget } from "./keys/types.ts";
import { basename } from "./pane.ts";
import { extensionOf } from "./sort.ts";

/**
 * What the copy chord puts on the clipboard, as text.
 *
 * The chord decides WHAT to copy; the host decides WHICH entries, applying the
 * rule every file operation here uses — the marked entries when there are any,
 * otherwise the one under the cursor. So this takes a list, and a list of one
 * is the ordinary case rather than a special one.
 *
 * The image destination is not here. Bytes are not text, and reading a file is
 * something only the main process may do.
 */
export type TextCopyTarget = Exclude<CopyTarget, "imageBytes">;

/**
 * Derive the text, from the paths and the directory they are in.
 *
 * `directory` is passed rather than derived from the paths because it is the
 * one destination that does not depend on there being an entry at all: the
 * directory you are standing in is copyable whether or not it holds anything,
 * and the chord reaches `d` before it checks for a target for exactly that
 * reason.
 */
export function clipboardText(
  target: TextCopyTarget,
  paths: readonly string[],
  directory: string,
): string {
  if (target === "directory") return directory;

  return paths.map((path) => segmentFor(target, path)).join("\n");
}

function segmentFor(target: Exclude<TextCopyTarget, "directory">, path: string): string {
  if (target === "path") return path;

  const name = basename(path);
  if (target === "filename") return name;

  // `extensionOf` and not a second `lastIndexOf(".")`. It already encodes the
  // rule that a leading dot does not start an extension — `.bashrc` is a name,
  // not an extension — and two copies would eventually disagree about it.
  const extension = extensionOf(name);
  return extension === "" ? name : name.slice(0, -(extension.length + 1));
}
