// Entry point: WorkloadRegistry.scan over owned private temporary filesystem fixtures.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as WorkloadRegistry from "./WorkloadRegistry.ts";
import { recordFixture } from "./workloadTestkit.ts";
import { workloadRecordKey } from "./WorkloadRecord.ts";

// The sandbox remaps /home and /tmp to nobody. Model the trusted host ancestors
// at the external filesystem boundary; fixture ownership/modes stay real.
vi.mock("node:fs/promises", async () => {
  const { fixtureFileSystem } = await import("./workloadTestkit.ts");
  return fixtureFileSystem();
});

const withRegistry = <A, E, R>(
  test: (root: string, path: Path.Path, fs: FileSystem.FileSystem) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-workload-reader-" });
    return yield* test(root, path, fs);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
const scan = (root: string) =>
  Effect.gen(function* () {
    return yield* (yield* WorkloadRegistry.WorkloadRegistry).scan;
  }).pipe(
    Effect.provide(WorkloadRegistry.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.provideService(HostProcess.Environment, { XDG_STATE_HOME: root }),
    Effect.provideService(HostProcess.Platform, "linux"),
  );
const writeRecord = (root: string, path: Path.Path, fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const dir = path.join(root, "mesura-code/workloads");
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    const record = recordFixture();
    const file = path.join(dir, `${record.recordKey}.json`);
    yield* fs.writeFileString(file, JSON.stringify(record), { mode: 0o600 });
    return { dir, file };
  });

it.effect(
  "F2 registry reads an atomic private record without changing filesystem permissions",
  () =>
    withRegistry((root, path, fs) =>
      Effect.gen(function* () {
        const { file } = yield* writeRecord(root, path, fs);
        const result = yield* scan(root);
        expect(result.state).toBe("available");
        expect(result.records).toEqual([recordFixture()]);
        expect(result.diagnostics).toEqual([]);
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      }),
    ),
);
it.effect.each(["public directory", "public record", "symlink", "hardlink", "oversize", "corrupt"])(
  "F2 registry rejects %s with explicit incomplete diagnostics",
  (kind) =>
    withRegistry((root, path, fs) =>
      Effect.gen(function* () {
        const { dir, file } = yield* writeRecord(root, path, fs);
        if (kind === "public directory") yield* fs.chmod(dir, 0o755);
        if (kind === "public record") yield* fs.chmod(file, 0o644);
        if (kind === "symlink") {
          yield* fs.rename(file, `${file}.target`);
          yield* fs.symlink(`${file}.target`, file);
        }
        if (kind === "hardlink") yield* fs.link(file, `${file}.other`);
        if (kind === "oversize") yield* fs.writeFileString(file, " ".repeat(1024 * 1024 + 1));
        if (kind === "corrupt") yield* fs.writeFileString(file, "{");
        const result = yield* scan(root);
        expect(result.records).toEqual([]);
        expect(result.incomplete).toBe(true);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        if (kind === "public directory") expect((yield* fs.stat(dir)).mode & 0o777).toBe(0o755);
      }),
    ),
);
it.effect("F2 registry absence remains distinct from unreadable or unsafe state", () =>
  withRegistry((root, path, fs) =>
    Effect.gen(function* () {
      expect((yield* scan(root)).state).toBe("absent");
      yield* fs.symlink(root, path.join(root, "mesura-code"));
      expect((yield* scan(root)).state).toBe("unknown");
    }),
  ),
);
it.effect(
  "F2 private registry accepts a readable runtime child below its private fixture parent",
  () =>
    withRegistry((root, path, fs) =>
      Effect.gen(function* () {
        const child = path.join(root, "runtime-child");
        yield* writeRecord(child, path, fs);
        yield* fs.chmod(child, 0o755);
        expect((yield* scan(child)).records).toHaveLength(1);
        expect((yield* fs.stat(child)).mode & 0o777).toBe(0o755);
      }),
    ),
);
it.effect.each(["record count", "aggregate bytes"])(
  "F2 bounded registry scan reports incomplete at %s limit",
  (kind) =>
    withRegistry((root, path, fs) =>
      Effect.gen(function* () {
        const { dir, file } = yield* writeRecord(root, path, fs);
        yield* fs.remove(file);
        const count = kind === "record count" ? 257 : 17;
        for (let index = 0; index < count; index++) {
          const name = `limit-${index}`;
          const unit = `mesura-workload-${name}.service`;
          const recordKey = yield* workloadRecordKey(unit);
          const record = recordFixture({
            name,
            unit,
            recordKey,
            argv: kind === "aggregate bytes" ? ["node", "x".repeat(1024 * 1024 - 1024)] : ["node"],
          });
          yield* fs.writeFileString(path.join(dir, `${recordKey}.json`), JSON.stringify(record), {
            mode: 0o600,
          });
        }
        const result = yield* scan(root);
        expect(result.incomplete).toBe(true);
        expect(result.records.length).toBe(kind === "record count" ? 256 : 16);
        expect(result.diagnostics).toContainEqual({ code: "scan-limit", count: 1 });
      }),
    ),
);
