import * as NodeCrypto from "node:crypto";

/**
 * Opaque, exclusive keyset cursors for agent thread search pages. Clients must
 * treat them as opaque. Each carries a kind tag, so a catalog cursor replayed
 * against evidence (or the reverse) is rejected instead of being read as a
 * boundary of the wrong table. Decoders return null for anything malformed or
 * foreign; callers restart at the first page, like thread detail cursors do.
 */

/** Boundary of the last catalog row delivered, under `(created_at DESC, thread_id ASC)`. */
export interface ThreadSearchCatalogCursor {
  readonly afterCreatedAt: string;
  readonly afterThreadId: string;
}

/**
 * Where an evidence walk resumes; the next page reads strictly past it. A
 * global walk moves down the table by rowid. A walk inside one thread moves
 * down that thread's `(created_at, message_id)` index instead, the only order
 * SQLite can read a thread in without sorting all of its messages first. Its
 * boundary is stored as the boundary row's rowid, not its message_id: message
 * ids have no length limit, and the cursor has one.
 */
export type ThreadSearchEvidencePosition =
  | { readonly kind: "rowid"; readonly beforeScanId: number }
  | { readonly kind: "thread"; readonly beforeCreatedAt: string; readonly beforeScanId: number };

/**
 * `searchKey` binds the position to the query and thread filter it was
 * produced for, so a cursor from another search cannot skip matches of this
 * one. The key covers the thread filter, so a key match also fixes the kind.
 */
export interface ThreadSearchEvidenceCursor {
  readonly position: ThreadSearchEvidencePosition;
  readonly searchKey: string;
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursorRecord(encoded: string | undefined): Record<string, unknown> | null {
  if (encoded === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

export function encodeThreadSearchCatalogCursor(cursor: ThreadSearchCatalogCursor): string {
  return encodeCursor({ k: "catalog", a: cursor.afterCreatedAt, i: cursor.afterThreadId });
}

export function decodeThreadSearchCatalogCursor(
  encoded: string | undefined,
): ThreadSearchCatalogCursor | null {
  const record = decodeCursorRecord(encoded);
  if (record?.k !== "catalog" || typeof record.a !== "string" || typeof record.i !== "string") {
    return null;
  }
  return { afterCreatedAt: record.a, afterThreadId: record.i };
}

/**
 * Fixed-length key for one evidence search. A hash keeps the cursor short
 * whatever the query length. `foldedQuery` must already be folded the way the
 * search matches, so queries that match identically share a key.
 */
export function threadSearchEvidenceKey(foldedQuery: string, threadId: string | null): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([foldedQuery, threadId]))
    .digest("base64url")
    .slice(0, 22);
}

export function encodeThreadSearchEvidenceCursor(cursor: ThreadSearchEvidenceCursor): string {
  const { position } = cursor;
  return encodeCursor(
    position.kind === "rowid"
      ? { k: "evidence", s: cursor.searchKey, r: position.beforeScanId }
      : {
          k: "evidence",
          s: cursor.searchKey,
          a: position.beforeCreatedAt,
          r: position.beforeScanId,
        },
  );
}

function decodeEvidencePosition(
  record: Record<string, unknown>,
): ThreadSearchEvidencePosition | null {
  if (typeof record.r !== "number" || !Number.isSafeInteger(record.r) || record.r < 1) {
    return null;
  }
  return typeof record.a === "string"
    ? { kind: "thread", beforeCreatedAt: record.a, beforeScanId: record.r }
    : { kind: "rowid", beforeScanId: record.r };
}

export function decodeThreadSearchEvidenceCursor(
  encoded: string | undefined,
  searchKey: string,
): ThreadSearchEvidenceCursor | null {
  const record = decodeCursorRecord(encoded);
  if (record?.k !== "evidence" || record.s !== searchKey) {
    return null;
  }
  const position = decodeEvidencePosition(record);
  return position === null ? null : { position, searchKey };
}
