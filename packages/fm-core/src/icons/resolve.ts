/**
 * Which symbol stands for a file, from its name alone.
 *
 * ── The art is borrowed; this cascade is not, and that is a deviation ───────
 * The plan expected to wrap `createFileTreeIconResolver` from `@pierre/trees`
 * rather than write this. That function turned out to handle only CUSTOM
 * remaps: the built-in name-to-token mapping lives in `resolveBuiltInFileIconToken`,
 * which the package's `exports` field does not publish, so reaching it would
 * mean importing a deep path the package forbids. The SPRITE — 58 symbols,
 * every drawing — still comes from the package. Only the naming does not.
 *
 * The token vocabulary below is the package's published `BuiltInFileIconToken`
 * union, so a name resolved here always addresses a symbol that exists.
 *
 * ── It never fails ─────────────────────────────────────────────────────────
 * An unknown extension resolves to `default`. A file manager that showed
 * nothing for an unrecognised file would show nothing for most of a source
 * tree.
 */

import { GENERIC } from "../mime.ts";

/** A symbol in the borrowed sprite. The package's own vocabulary. */
export type IconToken =
  | "astro"
  | "bash"
  | "biome"
  | "bun"
  | "c"
  | "claude"
  | "cpp"
  | "css"
  | "database"
  | "default"
  | "docker"
  | "eslint"
  | "font"
  | "git"
  | "go"
  | "graphql"
  | "html"
  | "image"
  | "javascript"
  | "json"
  | "markdown"
  | "npm"
  | "prettier"
  | "python"
  | "react"
  | "ruby"
  | "rust"
  | "sass"
  | "svelte"
  | "svg"
  | "swift"
  | "table"
  | "tailwind"
  | "terraform"
  | "text"
  | "typescript"
  | "vite"
  | "vue"
  | "wasm"
  | "yml"
  | "zig"
  | "zip";

/**
 * Whole names that carry a meaning no extension does.
 *
 * Matched first, and on the full lowercased name. `package.json` is npm's, not
 * JSON's, and a reader scanning a directory is helped more by the former.
 */
const BY_NAME: ReadonlyMap<string, IconToken> = new Map([
  ["package.json", "npm"],
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "npm"],
  ["pnpm-workspace.yaml", "npm"],
  ["dockerfile", "docker"],
  ["docker-compose.yml", "docker"],
  ["docker-compose.yaml", "docker"],
  ["makefile", "text"],
  ["cmakelists.txt", "text"],
  ["pkgbuild", "bash"],
  ["readme.md", "markdown"],
  ["license", "text"],
  [".gitignore", "git"],
  [".gitattributes", "git"],
  [".gitmodules", "git"],
  ["biome.json", "biome"],
  ["biome.jsonc", "biome"],
  [".prettierrc", "prettier"],
  ["vite.config.ts", "vite"],
  ["vite.config.js", "vite"],
  ["tailwind.config.ts", "tailwind"],
  ["bun.lockb", "bun"],
  ["claude.md", "claude"],
  ["agents.md", "claude"],
]);

/**
 * Extensions, matched LONGEST SUFFIX FIRST.
 *
 * `component.spec.ts` is a test before it is TypeScript, and `.env.local` is an
 * environment file before it is a `local`. Matching the shortest suffix first
 * would resolve both to the wrong thing — which is why the candidate list is
 * built longest-first and this table may hold multi-part keys.
 */
const BY_EXTENSION: ReadonlyMap<string, IconToken> = new Map([
  ["spec.ts", "typescript"],
  ["test.ts", "typescript"],
  ["spec.tsx", "react"],
  ["d.ts", "typescript"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["tsx", "react"],
  ["jsx", "react"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json", "json"],
  ["jsonc", "json"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["mdx", "markdown"],
  ["py", "python"],
  ["rs", "rust"],
  ["go", "go"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["hpp", "cpp"],
  ["rb", "ruby"],
  ["swift", "swift"],
  ["zig", "zig"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["fish", "bash"],
  ["html", "html"],
  ["xhtml", "html"],
  ["css", "css"],
  ["scss", "sass"],
  ["sass", "sass"],
  ["svg", "svg"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["astro", "astro"],
  ["yml", "yml"],
  ["yaml", "yml"],
  ["toml", "text"],
  ["ini", "text"],
  ["conf", "text"],
  ["txt", "text"],
  ["log", "text"],
  ["sql", "database"],
  ["db", "database"],
  ["sqlite", "database"],
  ["csv", "table"],
  ["tsv", "table"],
  ["xlsx", "table"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
  ["tf", "terraform"],
  ["wasm", "wasm"],
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["gif", "image"],
  ["webp", "image"],
  ["avif", "image"],
  ["bmp", "image"],
  ["ico", "image"],
  ["ttf", "font"],
  ["otf", "font"],
  ["woff", "font"],
  ["woff2", "font"],
  ["zip", "zip"],
  ["tar", "zip"],
  ["gz", "zip"],
  ["xz", "zip"],
  ["zst", "zip"],
  ["7z", "zip"],
  ["rar", "zip"],
]);

/**
 * Every dot-suffix of a name, longest first.
 *
 * `component.spec.ts` gives `["spec.ts", "ts"]`. A leading dot is not a
 * separator — `.env.local` gives `["env.local", "local"]`, not `["", …]` —
 * because a dotfile's first dot marks it hidden rather than starting an
 * extension.
 */
export function extensionCandidates(name: string): string[] {
  const parts = name.toLowerCase().split(".");
  const candidates: string[] = [];

  // From index 1: index 0 is the stem, and for a dotfile it is the empty
  // string before the leading dot.
  for (let i = 1; i < parts.length; i++) candidates.push(parts.slice(i).join("."));
  return candidates;
}

/**
 * The symbol for a filename.
 *
 * Whole names first, then extensions longest-suffix-first, then `default`.
 */
export function iconTokenFor(name: string): IconToken {
  const byName = BY_NAME.get(name.toLowerCase());
  if (byName !== undefined) return byName;

  for (const candidate of extensionCandidates(name)) {
    const byExtension = BY_EXTENSION.get(candidate);
    if (byExtension !== undefined) return byExtension;
  }

  return "default";
}

/**
 * The symbols the borrowed set does not carry.
 *
 * Folder, video, audio, document, symbolic link and executable have no drawing
 * in it — they are chrome, not file types, and they come from the general icon
 * library instead. Named here so the renderer's mapping is data rather than a
 * chain of conditionals.
 */
/**
 * `symlink` is deliberately absent, and used to be here.
 *
 * `chromeIconFor` never returned it — nothing passes it the one input that
 * could decide it — so the arm and its drawing were unreachable. A symlink
 * draws its TARGET's symbol today, which is what a reader wants anyway: the
 * question "what is this file" is about the target. Re-add it only alongside a
 * caller that can answer it.
 */
export type ChromeIcon = "folder" | "video" | "audio" | "document" | "binary";

/**
 * The same three answers, reachable from a NAME when there is no MIME type.
 *
 * A MIME type is authoritative and is always preferred — but **no caller
 * supplies one today**, and that is worth saying plainly rather than implying
 * otherwise. `FsEntry` and `EntrySummary` carry no MIME field, and all four
 * call sites pass a name and a kind. The parameter exists so the privileged
 * half can start supplying one without every caller changing; until it does,
 * the name path is the only live path.
 *
 * Without it the finder's rows — which come from a search index that carries
 * no type at all — draw the blank `default` symbol for a video, which reads as
 * a broken icon rather than as a fallback.
 *
 * Extensions rather than a guess: this is the same shape of table as
 * `BY_EXTENSION` above and belongs beside it, so changing what a `.mkv` draws
 * is one edit in the one file that owns icon naming.
 */
const CHROME_BY_EXTENSION: ReadonlyMap<string, ChromeIcon> = new Map([
  ["mp4", "video"],
  ["m4v", "video"],
  ["mkv", "video"],
  ["mov", "video"],
  ["webm", "video"],
  ["avi", "video"],
  ["wmv", "video"],
  ["flv", "video"],
  ["mpg", "video"],
  ["mpeg", "video"],
  ["m2ts", "video"],
  ["3gp", "video"],
  ["mp3", "audio"],
  ["m4a", "audio"],
  ["aac", "audio"],
  ["flac", "audio"],
  ["ogg", "audio"],
  ["opus", "audio"],
  ["wav", "audio"],
  ["wma", "audio"],
  ["aiff", "audio"],
  ["mid", "audio"],
  ["midi", "audio"],
  ["pdf", "document"],
  ["epub", "document"],
  ["djvu", "document"],
  ["ps", "document"],
  // Office formats sit here rather than in the file-type table because `xlsx`
  // is already `table` there and a document beside a spreadsheet is the pairing
  // a reader expects.
  ["doc", "document"],
  ["docx", "document"],
  ["odt", "document"],
  ["rtf", "document"],
]);

/**
 * The extensions the chrome table claims, for the check that keeps the two
 * tables disjoint. Exported as data rather than duplicated in the test, so the
 * check cannot drift from the table it is checking.
 */
export const CHROME_EXTENSIONS: readonly string[] = [...CHROME_BY_EXTENSION.keys()];

/**
 * Whether a MIME type actually tells us anything.
 *
 * Absent, empty and `application/octet-stream` are all the same statement —
 * "nothing was established" — and `classify` in `mime.ts` already treats the
 * last two that way. Reading them as a fact is what sends a `.pdf` the database
 * could not type to the blank default symbol.
 */
function saysSomething(mime: string | null): mime is string {
  return mime !== null && mime !== "" && mime !== GENERIC;
}

/**
 * What an entry needs drawn, when a file-type symbol is not the answer.
 *
 * `name` is consulted ONLY for a FILE whose MIME type says nothing. A
 * directory and an `other` answer from the kind alone and never read either
 * argument; and where a real type exists it wins, because a name is an
 * inference and an inference must not override what the filesystem
 * established.
 */
export function chromeIconFor(
  kind: "file" | "directory" | "other",
  mime: string | null,
  name?: string,
): ChromeIcon | null {
  if (kind === "directory") return "folder";
  if (kind === "other") return "binary";

  if (saysSomething(mime)) {
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "document";
    // A type that IS known and is none of those wants a file-type symbol, not
    // a chrome one. Falling through to the name here would let a mislabelled
    // extension overrule the filesystem.
    return null;
  }

  if (name === undefined) return null;
  // Not lowercased here: `extensionCandidates` does it, and doing it twice
  // leaves a reader asking which one is load-bearing.
  for (const candidate of extensionCandidates(name)) {
    const byExtension = CHROME_BY_EXTENSION.get(candidate);
    if (byExtension !== undefined) return byExtension;
  }
  return null;
}
