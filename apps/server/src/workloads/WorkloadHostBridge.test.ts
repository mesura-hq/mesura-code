// Entry point: the real direct bridge, with scoped children and owned temp paths.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as WorkloadHostBridge from "./WorkloadHostBridge.ts";
import { withHostBridgeFixture, controlTargetSource } from "./workloadTestkit.ts";

it.effect("direct replay preserves literal argv, cwd and only the approved environment", () =>
  withHostBridgeFixture(({ record, receipt, children }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* bridge.available).toBe(true);
      expect(yield* bridge.validateReplay(record)).toBe(null);
      expect(yield* bridge.replay(record)).toBe(0);
      const target = JSON.parse(yield* fs.readFileString(receipt));
      expect(target.argv).toEqual(["literal argument", "$(untouched)"]);
      expect(target.cwd).toBe(record.cwd);
      expect(target.env).toMatchObject({
        PATH: record.PATH,
        HOME: record.cwd,
        CODEX_THREAD_ID: "native-a",
        MESURA_ENVIRONMENT_ID: "environment-a",
        MESURA_PROVIDER_INSTANCE_ID: "codex",
        MESURA_WORKLOAD_IDENTITY_KIND: "codex-thread",
      });
      for (const name of [
        "ACCESS_TOKEN",
        "CODEX_HOME",
        "BASH_ENV",
        "ENV",
        "NODE_OPTIONS",
        "MESURA_THREAD_ID",
        "MESURA_WORKLOAD_GENERATION",
        "MESURA_WORKLOAD_LOCK_HANDOFF",
      ])
        expect(target.env[name]).toBeUndefined();
      expect(children).toHaveLength(1);
      for (const child of children) expect(yield* fs.exists(`/proc/${child.pid}`)).toBe(false);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("direct stop invokes the trusted manager with the canonical unit", () =>
  withHostBridgeFixture(({ record, actions }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* bridge.stop(record)).toBe(0);
      expect(JSON.parse(yield* fs.readFileString(actions))).toEqual([
        "--user",
        "stop",
        record.unit,
      ]);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each([0, 3, 1])(
  "direct replay retains exit %s without inventing an admission receipt",
  (code) =>
    withHostBridgeFixture(
      ({ record }) =>
        Effect.gen(function* () {
          const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
          expect(yield* bridge.replay(record)).toBe(code);
        }),
      { script: `#!/usr/bin/python3\nraise SystemExit(${code})\n` },
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect.each([
  { name: "missing PATH", changes: { PATH: null }, reason: "replay-context-unavailable" },
  { name: "empty PATH", changes: { PATH: "" }, reason: "replay-context-unavailable" },
  { name: "unknown executable", changes: { argv: ["/does/not/exist"] }, reason: "invalid-launch" },
  { name: "invalid memory", changes: { memoryHigh: "--invalid" }, reason: "invalid-launch" },
])("direct preflight refuses $name before any launch", ({ changes, reason }) =>
  withHostBridgeFixture(({ record, children }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      expect(yield* bridge.validateReplay({ ...record, ...changes })).toBe(reason);
      expect(children).toHaveLength(0);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("direct replay resolves a relative executable against the recorded cwd", () =>
  withHostBridgeFixture(({ record, root, receipt }) =>
    Effect.gen(function* () {
      const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        root + "/relative-target",
        "#!/usr/bin/python3\n" + controlTargetSource,
        { mode: 0o700 },
      );
      const relative = { ...record, argv: ["./relative-target", receipt, "relative argument"] };
      expect(yield* bridge.validateReplay(relative)).toBe(null);
      expect(yield* bridge.replay(relative)).toBe(0);
      const target = JSON.parse(yield* fs.readFileString(receipt));
      expect(target.cwd).toBe(root);
      expect(target.argv).toEqual(["relative argument"]);
    }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("interrupting direct execution closes its captured child", () =>
  withHostBridgeFixture(
    ({ record, children, launched }) =>
      Effect.gen(function* () {
        const bridge = yield* WorkloadHostBridge.WorkloadHostBridge;
        const fs = yield* FileSystem.FileSystem;
        const request = yield* bridge.replay(record).pipe(Effect.forkScoped);
        yield* Deferred.await(launched);
        expect(children).toHaveLength(1);
        yield* Fiber.interrupt(request);
        expect(yield* fs.exists(`/proc/${children[0]!.pid}`)).toBe(false);
      }),
    { script: "#!/usr/bin/python3\nimport signal\nsignal.pause()\n" },
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
