import type { WorkloadDiagnostic, WorkloadListResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem cannot expose no-follow/non-blocking open with descriptor inode/UID/mode/nlink validation. Retain this boundary until it does.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- These no-follow/non-blocking flags keep the validated descriptor; FileSystem does not expose them. Remove when it does.
import * as NodeFS from "node:fs";
import * as Path from "effect/Path";
import { decodeWorkloadRecord, type WorkloadRecord } from "./WorkloadRecord.ts";

export interface RegistrySnapshot {
  readonly state: WorkloadListResult["registryState"];
  readonly records: ReadonlyArray<WorkloadRecord>;
  readonly incomplete: boolean;
  readonly diagnostics: ReadonlyArray<WorkloadDiagnostic>;
}
export class WorkloadRegistry extends Context.Service<
  WorkloadRegistry,
  {
    readonly scan: Effect.Effect<RegistrySnapshot>;
  }
>()("t3/workloads/WorkloadRegistry") {}

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 256;

class UnsafeRegistry extends Error {}
class UnsafeRecord extends Error {}
class RecordLimit extends Error {}

async function validateDirectory(directory: string, uid: number, path: Path.Path) {
  // Match the wrapper's V3 trusted-ancestor policy. This does not provide
  // anchored directory-FD traversal against hostile same-UID namespace changes.
  if (!path.isAbsolute(directory)) throw new UnsafeRegistry();
  let current = path.parse(directory).root;
  const parts = directory.slice(current.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const link = await NodeFSP.lstat(current);
    const final = index === parts.length - 1;
    if (link.isSymbolicLink() && (final || link.uid !== 0)) throw new UnsafeRegistry();
    const info = link.isSymbolicLink() ? await NodeFSP.stat(current) : link;
    if (!info.isDirectory()) throw new UnsafeRegistry();
    if (final) {
      if (info.uid !== uid || (info.mode & 0o077) !== 0) throw new UnsafeRegistry();
    } else if (
      (info.uid !== 0 && info.uid !== uid) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new UnsafeRegistry();
  }
}

async function readPrivateRecord(file: string, uid: number) {
  const link = await NodeFSP.lstat(file);
  const safe = (info: typeof link) =>
    info.isFile() && info.uid === uid && (info.mode & 0o077) === 0 && info.nlink === 1;
  if (!safe(link)) throw new UnsafeRecord();
  // O_NONBLOCK prevents a raced FIFO replacement from blocking before fstat.
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!safe(info) || info.dev !== link.dev || info.ino !== link.ino) throw new UnsafeRecord();
    if (info.size > MAX_RECORD_BYTES) throw new RecordLimit();
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_RECORD_BYTES) throw new RecordLimit();
    const after = await handle.stat();
    const pathAfter = await NodeFSP.lstat(file);
    if (
      !safe(after) ||
      !safe(pathAfter) ||
      after.size !== size ||
      after.mtimeMs !== info.mtimeMs ||
      pathAfter.dev !== info.dev ||
      pathAfter.ino !== info.ino
    )
      throw new UnsafeRecord();
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
      size,
    };
  } finally {
    await handle.close();
  }
}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const uid = yield* Effect.sync(() => process.getuid?.());
  const root = path.join(
    environment.XDG_STATE_HOME || path.join(home, ".local/state"),
    "mesura-code/workloads",
  );
  const scan: WorkloadRegistry["Service"]["scan"] =
    platform !== "linux" || uid === undefined
      ? Effect.succeed({ state: "unsupported", records: [], incomplete: false, diagnostics: [] })
      : Effect.tryPromise(async () => {
          const records: Array<{ readonly text: string; readonly filename: string }> = [];
          const counts = new Map<WorkloadDiagnostic["code"], number>();
          const issue = (code: WorkloadDiagnostic["code"]) =>
            counts.set(code, (counts.get(code) ?? 0) + 1);
          const snapshot = (state: RegistrySnapshot["state"]) => ({
            state,
            records,
            incomplete: counts.size > 0,
            diagnostics: [...counts].map(([code, count]) => ({ code, count })),
          });
          try {
            await validateDirectory(root, uid, path);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return snapshot("absent");
            issue(error instanceof UnsafeRegistry ? "unsafe-registry" : "unreadable-registry");
            return snapshot("unknown");
          }
          const directory = await NodeFSP.opendir(root);
          let bytes = 0;
          let entries = 0;
          let candidates = 0;
          try {
            for await (const entry of directory) {
              if (++entries > 1024) {
                issue("scan-limit");
                break;
              }
              if (!/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
              if (++candidates > MAX_RECORDS) {
                issue("scan-limit");
                break;
              }
              try {
                const data = await readPrivateRecord(path.join(root, entry.name), uid);
                bytes += data.size;
                if (bytes > MAX_SCAN_BYTES) {
                  issue("scan-limit");
                  break;
                }
                records.push({ text: data.text, filename: entry.name });
              } catch (error) {
                issue(
                  error instanceof RecordLimit
                    ? "scan-limit"
                    : error instanceof UnsafeRecord
                      ? "unsafe-record"
                      : "invalid-record",
                );
              }
            }
            await validateDirectory(root, uid, path);
          } catch {
            records.length = 0;
            issue("unreadable-registry");
            return snapshot("unknown");
          }
          return snapshot("available");
        }).pipe(
          Effect.flatMap((snapshot) =>
            Effect.gen(function* () {
              const records: WorkloadRecord[] = [];
              let invalid = 0;
              for (const file of snapshot.records) {
                const decoded = yield* decodeWorkloadRecord(file.text, file.filename);
                if (Option.isSome(decoded)) records.push(decoded.value);
                else invalid++;
              }
              return {
                ...snapshot,
                records,
                incomplete: snapshot.incomplete || invalid > 0,
                diagnostics:
                  invalid > 0
                    ? [...snapshot.diagnostics, { code: "invalid-record" as const, count: invalid }]
                    : snapshot.diagnostics,
              };
            }),
          ),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.orElseSucceed(() => ({
            state: "unknown" as const,
            records: [],
            incomplete: true,
            diagnostics: [{ code: "unreadable-registry" as const, count: 1 }],
          })),
        );
  return WorkloadRegistry.of({ scan });
});
export const layer = Layer.effect(WorkloadRegistry, make);
