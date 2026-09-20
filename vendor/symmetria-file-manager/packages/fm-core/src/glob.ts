/**
 * Filename-glob matching, for the patterns the XDG mime database actually uses.
 *
 * The first draft handled only a leading `*`, which is wrong for real rows the
 * database carries — `*.tar.*`, `vgcore.*`, `core.*` — and wrong in the worst
 * way: the type silently resolves to the next-best match, or to nothing, with
 * no error anywhere.
 *
 * Three constructs are supported, because those are the three `globs2` uses:
 * `*` for any run of characters, `?` for one, and `[...]` for a character class
 * (including a `!` or `^` negation and `a-z` ranges). Everything else is a
 * literal, escaped.
 */

/** Characters that must be escaped to survive as literals in a `RegExp`. */
const SPECIAL = /[.+^${}()|\\]/g;

/**
 * Translate one glob to an anchored regular expression.
 *
 * Case folding is the caller's decision: the database's `cs` flag marks the
 * minority of rows that are case-SENSITIVE — `*.[Cc]` distinguishes a C source
 * from a C++ one — and everything else matches case-insensitively, which is why
 * `photo.JPG` resolves at all.
 */
export function globToRegExp(pattern: string, caseSensitive = false): RegExp {
  let source = "^";

  for (let i = 0; i < pattern.length; i++) {
    // SAFETY: `i < pattern.length` is the loop condition.
    const char = pattern[i] as string;

    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        // An unterminated class is a literal bracket, not a syntax error. The
        // database is user-extensible and a malformed row must not throw.
        source += "\\[";
        continue;
      }
      source += translateClass(pattern.slice(i + 1, close));
      i = close;
      continue;
    }
    source += char.replace(SPECIAL, "\\$&");
  }

  return new RegExp(`${source}$`, caseSensitive ? "" : "i");
}

function translateClass(body: string): string {
  const negated = body.startsWith("!") || body.startsWith("^");
  const chars = negated ? body.slice(1) : body;
  // Only `]` and `\` need escaping inside a class; `-` keeps its range meaning.
  return `[${negated ? "^" : ""}${chars.replace(/[\]\\]/g, "\\$&")}]`;
}

/**
 * How specific a pattern is, for ranking two that both match.
 *
 * A pattern with no wildcard at all is a whole-name match and beats every glob
 * — `Makefile` must win over `*`. Among globs, the longer one is the more
 * specific: `*.tar.gz` beats `*.gz` on the same filename.
 */
export function specificity(pattern: string): number {
  const isLiteral = !/[*?[]/.test(pattern);
  return (isLiteral ? 1_000_000 : 0) + pattern.length;
}
