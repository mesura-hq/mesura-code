// Entry point: the real WorkloadHostBridge with scoped OS children in owned temp paths.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as WorkloadHostBridge from "./WorkloadHostBridge.ts";
import { withHostBridgeFixture, controlTargetSource } from "./workloadTestkit.ts";

const contenderSource =
  "import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW);\ntry: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(11)";
const contender = (lock: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("/usr/bin/python3", ["-c", contenderSource, lock], {
        env: {},
        extendEnv: false,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        forceKillAfter: "2 seconds",
      }),
    );
    return yield* child.exitCode;
  }).pipe(Effect.scoped);

it.effect("F2 control V2 actual OFD stays held through V4 handoff target exit and validation", () =>
  withHostBridgeFixture(({ record, lock, receipt, children }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* bridge.available).toBe(true);
      yield* bridge.withLock(record, (lease) =>
        Effect.gen(function* () {
          expect(yield* contender(lock)).toBe(11);
          expect(yield* lease.validateReplay(record)).toBe(null);
          expect(yield* lease.replay(record)).toBe(0);
          expect(yield* contender(lock)).toBe(11);
          const target = JSON.parse(yield* fs.readFileString(receipt));
          expect(target.argv).toEqual(["literal argument", "$(untouched)"]);
          expect(target.cwd).toBe(record.cwd);
          expect(target.fd9).toBe(false);
          expect(target.stdio).toEqual(["/dev/null", "/dev/null", "/dev/null"]);
          expect(target.env).toMatchObject({
            PATH: record.PATH,
            MESURA_ENVIRONMENT_ID: "environment-a",
            MESURA_PROVIDER_INSTANCE_ID: "codex",
            MESURA_WORKLOAD_IDENTITY_KIND: "codex-thread",
            CODEX_THREAD_ID: "native-a",
          });
          expect(target.env).not.toHaveProperty("MESURA_WORKLOAD_LOCK_HANDOFF");
          for (const key of [
            "CODEX_HOME",
            "ACCESS_TOKEN",
            "BASH_ENV",
            "ENV",
            "NODE_OPTIONS",
            "MESURA_THREAD_ID",
            "MESURA_WORKLOAD_GENERATION",
          ])
            expect(target.env).not.toHaveProperty(key);
          expect(yield* fs.readFileString(lock)).toBe("retained");
        }),
      );
      expect(yield* contender(lock)).toBe(0);
      for (const child of children) expect(yield* fs.exists(`/proc/${child.pid}`)).toBe(false);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["mode", "symlink", "links"] as const)(
  "F2 control V2 actual lock refuses unsafe %s without repairing the file",
  (unsafe) =>
    withHostBridgeFixture(
      ({ record, receipt }) =>
        Effect.gen(function* () {
          const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
          const fs = yield* FileSystem.FileSystem;
          expect(
            yield* bridge
              .withLock(record, () => Effect.die("unsafe lock admitted"))
              .pipe(Effect.flip),
          ).toMatchObject({
            _tag: "WorkloadBridgeError",
            reason: "lock-unavailable",
            stage: "descriptor",
          });
          expect(yield* fs.exists(receipt)).toBe(false);
        }),
      { unsafe },
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("F2 control V2 unknown installed digest never opens a control lock", () =>
  withHostBridgeFixture(
    ({ record, receipt }) =>
      Effect.gen(function* () {
        const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
        const fs = yield* FileSystem.FileSystem;
        expect(yield* bridge.available).toBe(false);
        expect(
          yield* bridge
            .withLock(record, () => Effect.die("unknown wrapper admitted"))
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "handoff-unavailable" });
        expect(yield* fs.exists(receipt)).toBe(false);
      }),
    { digest: "0".repeat(64) },
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("F2 control V2 30 second lock acquisition bounds and reaps a queued alias child", () =>
  withHostBridgeFixture(({ record, waiting, children }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const fs = yield* FileSystem.FileSystem;
      yield* bridge.withLock(record, () =>
        Effect.gen(function* () {
          // A fresh waiter uses another description for the same canonical inode.
          const second = yield* bridge
            .withLock(
              { ...record, name: "preview.service", environmentId: "another-environment" },
              () => Effect.die("alias bypassed lock"),
            )
            .pipe(Effect.flip, Effect.forkScoped);
          // The first lease emitted waiting already; observe the new child's actual
          // reader milestone with its own Deferred rather than synthetic scheduling.
          yield* Deferred.await(waiting);
          yield* TestClock.adjust("31 seconds");
          expect(yield* Fiber.join(second)).toMatchObject({ reason: "lock-unavailable" });
        }),
      );
      for (const child of children) expect(yield* fs.exists(`/proc/${child.pid}`)).toBe(false);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "F2 control V2 actual bridge cancellation reaps only its captured waiter and retains the holder",
  () =>
    withHostBridgeFixture(({ record, lock, waiting, children }) =>
      Effect.gen(function* () {
        const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
        const fs = yield* FileSystem.FileSystem;
        yield* bridge.withLock(record, () =>
          Effect.gen(function* () {
            const second = yield* bridge
              .withLock(record, () => Effect.die("cancelled waiter admitted"))
              .pipe(Effect.forkScoped);
            yield* Deferred.await(waiting);
            yield* Fiber.interrupt(second);
            expect(yield* fs.exists(`/proc/${children[1]!.pid}`)).toBe(false);
            expect(yield* fs.exists(`/proc/${children[0]!.pid}`)).toBe(true);
            expect(yield* contender(lock)).toBe(11);
          }),
        );
        expect(yield* contender(lock)).toBe(0);
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("F2 control V2 OS fixture keeps the strict trusted ancestor owner contract", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "/usr/bin/python3",
        [
          "-c",
          'import json,os; print(json.dumps({"uid":os.getuid(),"rootOwner":os.stat("/").st_uid,"tmpOwner":os.stat("/tmp").st_uid}))',
        ],
        {
          shell: false,
          env: {},
          extendEnv: false,
          stdin: "ignore",
          stderr: "ignore",
          forceKillAfter: "2 seconds",
        },
      ),
    );
    const metadata = JSON.parse(yield* Stream.mkString(child.stdout.pipe(Stream.decodeText())));
    expect(yield* child.exitCode).toBe(0);
    expect([0, metadata.uid]).toContain(metadata.rootOwner);
    expect([0, metadata.uid]).toContain(metadata.tmpOwner);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("F2 control V2 replay resolves a relative executable against the recorded cwd", () =>
  withHostBridgeFixture(({ record, root, receipt }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        root + "/relative-target",
        "#!/usr/bin/python3\n" + controlTargetSource,
        {
          mode: 0o700,
        },
      );
      const relative = { ...record, argv: ["./relative-target", receipt, "relative argument"] };
      yield* bridge.withLock(relative, (lease) =>
        Effect.gen(function* () {
          expect(yield* lease.validateReplay(relative)).toBe(null);
          expect(yield* lease.replay(relative)).toBe(0);
          const target = JSON.parse(yield* fs.readFileString(receipt));
          expect(target.cwd).toBe(root);
          expect(target.argv).toEqual(["relative argument"]);
        }),
      );
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
