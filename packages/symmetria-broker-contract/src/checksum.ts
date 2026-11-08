/**
 * The checksum a second repository pins over the emitted JSON Schema documents. The framing is part
 * of the contract: files in ascending relative-path order, each absorbed as path, NUL, exact bytes,
 * NUL; the NULs keep a rename from cancelling a content change. The bytes are already canonical
 * (sorted keys), so an Effect release that reorders keys does not read as a contract change.
 */
// @effect-diagnostics nodeBuiltinImport:off - hashing a build artifact is a
// package tool, not runtime contract logic, and the Effect `Crypto` service
// would make every caller effectful for one synchronous digest.
import * as NodeCrypto from "node:crypto";

/** The file every emitted document set is indexed by. */
export const SYMMETRIA_SCHEMA_INDEX_FILE = "index.json";

/** One emitted document, as the checksum sees it. */
export type SymmetriaChecksumEntry = {
  /** Path of the document relative to the `schema/` directory, POSIX-separated. */
  readonly file: string;
  /** The exact source the emitter writes to disk. */
  readonly source: string;
};

/**
 * Recursively sorts object keys, leaving arrays in place. Array order carries
 * meaning in JSON Schema — `required` and `anyOf` are ordered — so only objects
 * are touched.
 */
export const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeJsonValue(child)] as const),
  );
};

/**
 * The one serialization every emitted artifact is written with. Matches the
 * golden fixtures of the earlier phases, so a reader diffing an artifact
 * against a fixture is comparing like with like.
 */
export const formatSymmetriaSchemaDocument = (value: unknown): string =>
  `${JSON.stringify(canonicalizeJsonValue(value), null, 2)}\n`;

/**
 * Hashes a set of emitted documents. Entries are sorted here rather than by the
 * caller, so a caller that walks a directory in some other order still gets the
 * pinned value.
 */
export const computeSymmetriaContractChecksum = (
  entries: ReadonlyArray<SymmetriaChecksumEntry>,
): string => {
  const hash = NodeCrypto.createHash("sha256");
  const ordered = [...entries].sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  );
  for (const entry of ordered) {
    hash.update(entry.file, "utf8");
    hash.update("\0");
    hash.update(entry.source, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
};

/** One root as the source checksum sees it: its name and its schema tree. */
export type SymmetriaSourceEntry = {
  readonly root: string;
  readonly ast: unknown;
};

/**
 * Keys are sorted, so a future Effect build that assembles the same tree in another order reads as
 * unchanged. A function renders by name, not body, so rewriting a predicate keeps the digest.
 */
const renderSchemaNode = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === "function") return `[function ${value.name}]`;
  if (typeof value === "bigint") return `[bigint ${value.toString()}]`;
  if (typeof value === "symbol") return `[symbol ${value.description ?? ""}]`;
  if (value === undefined) return "[undefined]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof RegExp) return `[regexp ${value.source}/${value.flags}]`;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((child) => renderSchemaNode(child, seen));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, renderSchemaNode(record[key], seen)] as const),
  );
};

/**
 * Hashes the schema trees, which catch what JSON Schema cannot express: a check applied after a
 * transformation is dropped on the way out, so weakening `TrimmedNonEmptyString` to `Schema.String`
 * emits identical documents. Kept beside the document checksum, which non-TypeScript consumers pin.
 * An Effect upgrade that reshapes the AST moves it: regenerate, read the diff, commit deliberately.
 */
export const computeSymmetriaSourceChecksum = (
  entries: ReadonlyArray<SymmetriaSourceEntry>,
): string => {
  const hash = NodeCrypto.createHash("sha256");
  const ordered = [...entries].sort((left, right) =>
    left.root < right.root ? -1 : left.root > right.root ? 1 : 0,
  );
  for (const entry of ordered) {
    hash.update(entry.root, "utf8");
    hash.update("\0");
    hash.update(JSON.stringify(renderSchemaNode(entry.ast, new WeakSet())) ?? "null", "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
};
