import { decodePath, failure, isRecord, type Result, success } from "../contract.ts";
export interface OverviewEntry {
  readonly name: string;
  readonly kind: "directory" | "file" | "other";
  readonly isSymlink: boolean;
  readonly isHidden: boolean;
}
export interface OverviewReply {
  readonly entries: readonly OverviewEntry[];
  readonly inspected: number;
  readonly truncated: boolean;
}
export interface OverviewRequest {
  readonly path: string;
  readonly requestId: string;
  readonly limit: number;
}
export function decodeOverviewRequest(raw: unknown): Result<OverviewRequest> {
  if (!isRecord(raw)) return failure("invalid_request", "overview request must be an object");
  const path = decodePath(raw.path);
  if (!path.ok) return path;
  if (
    typeof raw.requestId !== "string" ||
    raw.requestId.length === 0 ||
    raw.requestId.length > 200 ||
    raw.requestId === "all"
  )
    return failure("invalid_request", "invalid overview request ID");
  if (
    typeof raw.limit !== "number" ||
    !Number.isInteger(raw.limit) ||
    raw.limit < 1 ||
    raw.limit > 1000
  )
    return failure("invalid_request", "overview limit must be 1–1000");
  return success({ path: path.value, requestId: raw.requestId, limit: raw.limit });
}
function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !/[/\0]/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}
function decodeEntry(raw: unknown): OverviewEntry | null {
  if (!isRecord(raw) || !validName(raw.name)) return null;
  if (raw.kind !== "directory" && raw.kind !== "file" && raw.kind !== "other") return null;
  if (typeof raw.isSymlink !== "boolean" || typeof raw.isHidden !== "boolean") return null;
  return { name: raw.name, kind: raw.kind, isSymlink: raw.isSymlink, isHidden: raw.isHidden };
}
export function decodeOverviewReply(raw: unknown): Result<OverviewReply> {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.entries) ||
    typeof raw.inspected !== "number" ||
    !Number.isInteger(raw.inspected) ||
    raw.inspected < 0 ||
    raw.inspected > 1000 ||
    typeof raw.truncated !== "boolean"
  )
    return failure("invalid_reply", "invalid overview reply");
  const entries: OverviewEntry[] = [];
  const names = new Set<string>();
  for (const item of raw.entries) {
    const entry = decodeEntry(item);
    if (!entry || names.has(entry.name)) return failure("invalid_reply", "invalid overview entry");
    entries.push(entry);
    names.add(entry.name);
  }
  if (entries.length > raw.inspected)
    return failure("invalid_reply", "overview exceeds inspected count");
  return success({ entries, inspected: raw.inspected, truncated: raw.truncated });
}
