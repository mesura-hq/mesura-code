/**
 * The checksum a second repository pins.
 *
 * A consumer outside this repository cannot depend on the TypeScript schemas;
 * it depends on the emitted JSON Schema documents. One hash over all of them is
 * the whole contract surface in a single value, so a consumer pins that value
 * and its own suite fails the moment this fork changes a schema without telling
 * anybody.
 *
 * The framing is fixed and part of the contract, because a hash is only
 * comparable across repositories when both sides frame it the same way. Files
 * are taken in ascending order of their relative path, and for each one the
 * hash absorbs the path, a NUL byte, the exact bytes on disk, and a second NUL
 * byte. The NUL separators are what stop a rename from cancelling out against a
 * content change: without them the concatenation of path and content is
 * ambiguous, and two different document sets could hash alike.
 *
 * The bytes on disk are already canonical — {@link canonicalizeJsonValue} sorts
 * every object key before the emitter serializes a document — so hashing the
 * bytes is hashing a canonical form. That is deliberate: a future Effect beta
 * that emits the same schema with its keys in a different order must not read
 * as a contract change, and it will not, because the emitter sorts them back.
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
 * A canonical, cycle-safe rendering of a schema tree.
 *
 * Keys are sorted, so a future Effect build that assembles the same tree in
 * another order reads as unchanged. A function is rendered by its name rather
 * than its body: a check keeps its identity, and rewriting the body of a
 * predicate without changing what it accepts does not move the digest.
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
 * Hashes the schemas themselves, not their JSON Schema projection.
 *
 * The document checksum above cannot see a change JSON Schema cannot express.
 * Measured on this contract: swapping a field from `TrimmedNonEmptyString` to
 * a bare `Schema.String` — a real weakening, since an empty title then decodes
 * — emits byte-identical documents, because a check applied after a
 * transformation is dropped on the way out. Against the schema trees the same
 * edit moves this value, so the drift test fails and the contract surface
 * cannot move in silence.
 *
 * It is recorded beside the document checksum rather than folded into it: a
 * consumer outside TypeScript can reproduce the document checksum from the
 * published bytes and can reproduce nothing about an Effect AST, so the two
 * values answer different questions. This one is a change detector for this
 * repository and its suite; the document checksum is the value a second
 * repository pins.
 *
 * It moves on an Effect upgrade that reshapes the AST, the same way the
 * upstream vocabulary locks fire on an upstream change. That is the intended
 * cost: regenerate, read the diff, and commit the new value deliberately.
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
