import { opendir } from "node:fs/promises";
import type { OverviewEntry, OverviewReply } from "@symmetria/fm-core/overview/contract";
/** Inspect only the requested prefix. A full prefix is conservatively incomplete. */
export async function readOverviewDirectory(
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<OverviewReply> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("invalid overview limit");
  signal?.throwIfAborted();
  const directory = await opendir(path, { bufferSize: 1 });
  const entries: OverviewEntry[] = [];
  try {
    while (entries.length < limit) {
      signal?.throwIfAborted();
      const entry = await directory.read();
      if (entry === null) return { entries, inspected: entries.length, truncated: false };
      entries.push({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        isSymlink: entry.isSymbolicLink(),
        isHidden: entry.name.startsWith("."),
      });
    }
    return { entries, inspected: entries.length, truncated: true };
  } finally {
    await directory.close();
  }
}
