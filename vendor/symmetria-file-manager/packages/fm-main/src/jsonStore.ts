import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A small JSON file a person may also edit by hand.
 *
 * Extracted when the listing store became the second one: the read below is
 * twenty-seven lines of the same three-way decision the bookmark store already
 * made, and a duplication check said so. Two copies of "is this absent, broken,
 * or usable" is exactly where the two drift and one of them starts overwriting
 * something it should not.
 */

/**
 * What a file said, or why it said nothing.
 *
 * Three answers rather than two, and the difference between the first two is
 * the whole point: `absent` is a first run, while `unreadable` is a file that
 * exists and did not parse — the user's own data, mid-edit, which is neither
 * trusted nor overwritten.
 */
export type JsonRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "object"; readonly value: Record<string, unknown> };

const ABSENT: JsonRead = { kind: "absent" };
const UNREADABLE: JsonRead = { kind: "unreadable" };

/** Read a JSON object, never throwing, saying which of the three happened. */
export async function readJsonObject(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // Only a genuinely absent file is a first run. A directory in its place, a
    // permission error or anything else is a file we could not read, and
    // writing over it would destroy something.
    //
    // SAFETY: every rejection from `node:fs` carries `code`; the cast names
    // the shape Node documents rather than asserting anything unchecked, and
    // an absent `code` simply falls through to `unreadable`.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? ABSENT : UNREADABLE;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Invalid JSON, and an EMPTY FILE is a special case of it: `JSON.parse("")`
    // throws. Both mean the same thing here — do not touch it.
    return UNREADABLE;
  }

  // A file holding `[]` or `"h=/home"` parsed and is not a store. Unreadable
  // rather than empty, which is the difference between "use the default and
  // leave my file alone to fix" and "the user deliberately chose nothing".
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return UNREADABLE;

  // SAFETY: the three tests above are exactly what distinguishes a plain
  // object from everything else `JSON.parse` can return. The cast names what
  // has just been checked; it asserts nothing further, and each caller runs its
  // own decoder over the result before believing a single field.
  return { kind: "object", value: parsed as Record<string, unknown> };
}

/**
 * Write a JSON object, atomically.
 *
 * Write-then-rename, because `rename` is the only step that is atomic and a
 * half-written file is an unreadable one on the next start. The temporary sits
 * beside the target rather than in `/tmp`: a rename across filesystems fails
 * with `EXDEV`, and two paths are guaranteed to share one only when they share
 * a directory.
 *
 * Indented and newline-terminated, because both of these are files a person
 * edits by hand.
 */
export async function writeJsonObject(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
