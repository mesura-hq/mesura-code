// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem does not expose the no-follow/nonblocking flags needed for validated descriptor reads. Remove when it does.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem cannot bind no-follow/nonblocking descriptor reads to nanosecond inode/mtime metadata. Remove when it does.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Hex from "effect/encoding/Hex";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";
import { knownMesuraCodexLauncher } from "./knownMesuraCodexLauncher.ts";

type Reason = ProviderAdapter.ProviderRuntimeResourceReason;
type Description = typeof knownMesuraCodexLauncher;

export class HostObservationError extends Schema.TaggedError<HostObservationError>()(
  "HostObservationError",
  {
    reason: Schema.Literals([
      "unsupported_platform",
      "unknown_launcher",
      "unsupported_path",
      "untrusted_chain",
      "ambient_cgroup",
      "capture_failed",
      "exited",
      "identity_changed",
      "not_initialized",
      "sample_failed",
      "ambiguous_scope",
      "incomplete",
      "unsupported_provider",
      "missing",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Cannot verify the provider runtime resource observation.";
  }
}

export interface HostFileIdentity {
  readonly kind: "file" | "directory" | "link" | "socket" | "other";
  readonly uid: number;
  readonly mode: number;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly modified: string;
}

/** Destination-host I/O is injected; bounded reads never execute launcher source. */
export class ProviderRuntimeHostIO extends Context.Service<
  ProviderRuntimeHostIO,
  {
    readonly platform: string;
    readonly arch: string;
    readonly callerPid: number;
    readonly callerUid: number;
    readonly cwd: string;
    readonly metadata: (path: string) => Effect.Effect<HostFileIdentity, HostObservationError>;
    readonly readLink: (path: string) => Effect.Effect<string, HostObservationError>;
    readonly read: (path: string, limit: number) => Effect.Effect<string, HostObservationError>;
  }
>()("t3/agentResources/ProviderRuntimeHost/ProviderRuntimeHostIO") {}

export class ProviderRuntimeHost extends Context.Service<
  ProviderRuntimeHost,
  {
    readonly prepare: (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<{
      readonly capture: (
        handle: Pick<ChildProcessSpawner.ChildProcessHandle, "pid" | "isRunning">,
      ) => Effect.Effect<ProviderAdapter.ProviderRuntimeObservation>;
    }>;
  }
>()("t3/agentResources/ProviderRuntimeHost") {}

const isHostObservationError = Schema.is(HostObservationError);
const unknownJson = Schema.fromJsonString(Schema.Unknown);

const refuse = (reason: Reason) => Effect.fail(new HostObservationError({ reason }));
const encodeFingerprint = Schema.encodeUnknownEffect(unknownJson);
const decodePackageJson = Schema.decodeUnknownEffect(unknownJson);
const failureDescriptor = (
  reason: Reason,
): Exclude<ProviderAdapter.ProviderRuntimeLaunchDescriptor, { readonly status: "verified" }> => ({
  status:
    reason === "capture_failed" ||
    reason === "exited" ||
    reason === "identity_changed" ||
    reason === "sample_failed"
      ? "unavailable"
      : "unsupported",
  verifiedScopeKey: null,
  reason,
});
const failureMemory = (reason: Reason): ProviderAdapter.ProviderRuntimeAnonymousMemory => ({
  ...failureDescriptor(reason),
  anonymousBytes: null,
  sampledAt: null,
});
const reasonOf = (error: HostObservationError): Reason => {
  switch (error.reason) {
    case "unsupported_platform":
    case "unknown_launcher":
    case "unsupported_path":
    case "untrusted_chain":
    case "ambient_cgroup":
    case "capture_failed":
    case "exited":
    case "identity_changed":
    case "not_initialized":
    case "sample_failed":
    case "ambiguous_scope":
    case "incomplete":
    case "unsupported_provider":
      return error.reason;
    default:
      return "sample_failed";
  }
};

function parseCounter(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStartTicks(text: string): string | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  return ticks !== undefined && /^\d+$/.test(ticks) && fields[0] !== "Z" && fields[0] !== "X"
    ? ticks
    : null;
}

function parseCgroup(text: string): string | null {
  const rows = text.trim().split("\n");
  if (rows.length !== 1 || !rows[0]?.startsWith("0::/")) return null;
  const path = rows[0].slice(3);
  return path.split("/").some((part) => part === "." || part === "..") || path.includes("\0")
    ? null
    : path;
}

const make = (description: Description | undefined) =>
  Effect.gen(function* () {
    const io = yield* ProviderRuntimeHostIO;
    const pathService = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const digest = (text: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
        Effect.map(Hex.encode),
        Effect.mapError((cause) => new HostObservationError({ reason: "sample_failed", cause })),
      );
    const fingerprint = (value: unknown) =>
      encodeFingerprint(value).pipe(
        Effect.mapError((cause) => new HostObservationError({ reason: "sample_failed", cause })),
        Effect.flatMap(digest),
      );
    const identityEqual = (a: HostFileIdentity, b: HostFileIdentity) =>
      Effect.gen(function* () {
        return (yield* fingerprint(a)) === (yield* fingerprint(b));
      });
    const boot = () =>
      io
        .read("/proc/sys/kernel/random/boot_id", 128)
        .pipe(
          Effect.flatMap((text) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/.test(text)
              ? Effect.succeed(text.trim())
              : refuse("identity_changed"),
          ),
        );
    const mount = () =>
      io.read(`/proc/${io.callerPid}/mountinfo`, 65536).pipe(
        Effect.flatMap((text) => {
          const candidates = text
            .trim()
            .split("\n")
            .filter((line) => line.split(" - ")[1]?.split(" ")[0] === "cgroup2");
          if (candidates.length !== 1) return refuse("ambient_cgroup");
          const fields = candidates[0]!.split(" - ")[0]!.split(" ");
          return fields[3] === "/" && fields[4] === "/sys/fs/cgroup"
            ? Effect.succeed(candidates[0]!)
            : refuse("ambient_cgroup");
        }),
      );
    const cgroup = (pid: number) =>
      io.read(`/proc/${pid}/cgroup`, 4096).pipe(
        Effect.flatMap((text) => {
          const parsed = parseCgroup(text);
          return parsed === null ? refuse("ambient_cgroup") : Effect.succeed(parsed);
        }),
      );
    const generation = (pid: number) =>
      Effect.gen(function* () {
        const bootId = yield* boot();
        const ticks = parseStartTicks(yield* io.read(`/proc/${pid}/stat`, 8192));
        if (ticks === null) return yield* refuse("exited");
        return `${bootId}:${ticks}`;
      });

    // Check lexical components as well as resolved targets. Linux link mode 0777
    // does not grant write authority; ownership and protected ancestors do.
    const trusted = (path: string, executable = true) =>
      Effect.gen(function* () {
        const records: Array<readonly [string, HostFileIdentity, string | null]> = [];
        let pending = path;
        for (let depth = 0; depth < 16; depth++) {
          if (!pathService.isAbsolute(pending) || pathService.normalize(pending) !== pending)
            return yield* refuse("untrusted_chain");
          const parts = pending.split("/").filter(Boolean);
          let current = "/";
          let redirect: string | null = null;
          for (let index = -1; index < parts.length; index++) {
            if (index >= 0) current = pathService.join(current, parts[index]!);
            const metadata = yield* io.metadata(current);
            if (metadata.uid !== 0) return yield* refuse("untrusted_chain");
            if (metadata.kind === "link") {
              const target = yield* io.readLink(current);
              records.push([current, metadata, target]);
              redirect = pathService.resolve(
                pathService.dirname(current),
                target,
                ...parts.slice(index + 1),
              );
              break;
            }
            if ((metadata.mode & 0o022) !== 0) return yield* refuse("untrusted_chain");
            const final = index === parts.length - 1;
            if (
              (!final && metadata.kind !== "directory") ||
              (final && metadata.kind !== "file") ||
              (final && executable && (metadata.mode & 0o111) === 0)
            )
              return yield* refuse("untrusted_chain");
            records.push([current, metadata, null]);
          }
          if (redirect === null) return { canonical: pending, records };
          pending = redirect;
        }
        return yield* refuse("untrusted_chain");
      });

    const select = (name: string, entries: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        for (const directory of entries) {
          const path = pathService.join(directory, name);
          const info = yield* io.metadata(path).pipe(Effect.result);
          if (info._tag === "Failure") {
            // Only a missing entry permits POSIX search to continue. Other metadata
            // failures can hide an earlier selected executable, so fail closed.
            if (info.failure.reason === "missing") continue;
            return yield* refuse("unsupported_path");
          }
          if (
            info.success.kind === "link" ||
            (info.success.kind === "file" && (info.success.mode & 0o111) !== 0)
          )
            return path;
        }
        return yield* refuse("unknown_launcher");
      });

    const prepare: ProviderRuntimeHost["Service"]["prepare"] = (input) =>
      Effect.gen(function* () {
        const launchToken = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const preflight = yield* Effect.gen(function* () {
          if (io.platform !== "linux" || io.arch !== "x64")
            return yield* refuse("unsupported_platform");
          if (description === undefined) return yield* refuse("unknown_launcher");
          const environment = input.environment;
          const pathKeys = Object.keys(environment).filter((key) => key.toLowerCase() === "path");
          const path = environment.PATH;
          if (pathKeys.length !== 1 || pathKeys[0] !== "PATH" || path === undefined)
            return yield* refuse("unsupported_path");
          const entries = path.split(":");
          if (
            entries.length > 64 ||
            entries.some(
              (entry) =>
                !entry.startsWith("/") ||
                entry.trim() !== entry ||
                pathService.normalize(entry) !== entry,
            )
          )
            return yield* refuse("unsupported_path");
          if (
            [
              "NODE_OPTIONS",
              "NODE_PATH",
              "NODE_COMPILE_CACHE",
              "LD_PRELOAD",
              "LD_LIBRARY_PATH",
              "BASH_ENV",
              "ENV",
              "SHELLOPTS",
              "BASHOPTS",
            ].some((key) => Boolean(environment[key])) ||
            Object.keys(environment).some((key) => key.startsWith("BASH_FUNC_"))
          )
            return yield* refuse("untrusted_chain");
          if (
            environment.MESURA_PROVIDER_PROBE !== undefined ||
            input.args.some((arg) => ["--no-session-persistence", "--ephemeral"].includes(arg)) ||
            ["--version", "-v", "-V"].includes(input.args[0] ?? "")
          )
            return yield* refuse("unknown_launcher");
          if (
            input.command.includes("/") &&
            (!pathService.isAbsolute(input.command) ||
              pathService.normalize(input.command) !== input.command)
          )
            return yield* refuse("unsupported_path");
          const selected = input.command.includes("/")
            ? input.command
            : yield* select(input.command, entries);
          if (selected !== description.invocation) return yield* refuse("unknown_launcher");
          const callerCgroup = yield* cgroup(io.callerPid);
          const suffix = "/app.slice/mesura-code.service";
          if (!callerCgroup.endsWith(suffix)) return yield* refuse("ambient_cgroup");
          // systemd expands the reviewed helper's --slice=mesura-agents.slice through mesura.slice.
          // A direct /mesura-agents.slice sibling rejected real scopes and made the old fixture lie.
          const slice = callerCgroup.slice(0, -suffix.length) + "/mesura.slice/mesura-agents.slice";
          const bus = pathService.join(
            environment.XDG_RUNTIME_DIR || `/run/user/${io.callerUid}`,
            "bus",
          );
          if (
            (yield* io.metadata(bus).pipe(Effect.catch(() => refuse("unknown_launcher")))).kind !==
            "socket"
          )
            return yield* refuse("unknown_launcher");
          const invocationLink = yield* io.readLink(description.invocation);
          const realLink = yield* io.readLink(description.realInvocation);
          if (
            invocationLink !== description.helper ||
            realLink !== "../lib/node_modules/@openai/codex/bin/codex.js"
          )
            return yield* refuse("unknown_launcher");
          const paths = [
            description.invocation,
            description.realInvocation,
            "/bin/sh",
            "/usr/bin/env",
          ];
          for (const name of ["basename", "cat", "id", "date", "systemd-run", "node"])
            paths.push(yield* select(name, entries));
          const packageJson = description.platformPackage + "/package.json";
          const packageIdentity = yield* trusted(packageJson, false);
          const packageBytes = yield* io.read(packageIdentity.canonical, 65536);
          const packageData = yield* decodePackageJson(packageBytes).pipe(
            Effect.mapError(
              (cause) => new HostObservationError({ reason: "unknown_launcher", cause }),
            ),
          );
          if (typeof packageData !== "object" || packageData === null || "exports" in packageData)
            return yield* refuse("unknown_launcher");
          paths.push(pathService.join(description.platformPackage, description.nativeRelativePath));
          const validate = () =>
            Effect.gen(function* () {
              const chain = yield* Effect.forEach(paths, (path) => trusted(path), {
                concurrency: 1,
              });
              const expectedCanonical = [
                description.helper,
                description.nodeSource,
                description.shellExecutable,
                "/usr/bin/env",
                ...["basename", "cat", "id", "date", "systemd-run"].map(
                  (name) => `/usr/bin/${name}`,
                ),
                description.nodeExecutable,
                pathService.join(description.platformPackage, description.nativeRelativePath),
              ];
              if (chain.some((entry, index) => entry.canonical !== expectedCanonical[index]))
                return yield* refuse("unknown_launcher");
              const pkg = yield* trusted(packageJson, false);
              const helper = chain[0]!;
              const source = chain[1]!;
              if (
                helper.canonical !== description.helper ||
                source.canonical !== description.nodeSource
              )
                return yield* refuse("unknown_launcher");
              const helperBytes = yield* io.read(helper.canonical, 65536);
              const sourceBytes = yield* io.read(source.canonical, 65536);
              if (
                (yield* digest(helperBytes)) !== description.helperSha256 ||
                (yield* digest(sourceBytes)) !== description.nodeSourceSha256
              )
                return yield* refuse("unknown_launcher");
              // Re-read identities after bytes to bind metadata and source to one pass.
              const after = yield* Effect.forEach(paths, (path) => trusted(path), {
                concurrency: 1,
              });
              const pkgAfter = yield* trusted(packageJson, false);
              if ((yield* fingerprint([chain, pkg])) !== (yield* fingerprint([after, pkgAfter])))
                return yield* refuse("identity_changed");
              return {
                fingerprint: yield* fingerprint([chain, pkg, helperBytes, sourceBytes]),
                node: chain[paths.length - 2]!,
              };
            });
          const baseline = yield* validate();
          return { validate, baseline, slice, callerBoot: yield* boot(), mount: yield* mount() };
        }).pipe(
          Effect.timeout("200 millis"),
          Effect.catch((cause) =>
            Effect.fail(
              isHostObservationError(cause)
                ? cause
                : new HostObservationError({ reason: "capture_failed", cause }),
            ),
          ),
          Effect.result,
        );

        return {
          capture: (handle) =>
            Effect.gen(function* () {
              const inert = (reason: Reason): ProviderAdapter.ProviderRuntimeObservation =>
                Object.freeze({
                  launchToken,
                  readLaunchDescriptor: Effect.succeed(failureDescriptor(reason)),
                  readAnonymousMemory: Effect.succeed(failureMemory(reason)),
                });
              if (preflight._tag === "Failure") return inert(reasonOf(preflight.failure));
              const proof = preflight.success;
              const captured = yield* Effect.gen(function* () {
                if (!(yield* handle.isRunning)) return yield* refuse("exited");
                const initialGeneration = yield* generation(Number(handle.pid));
                const chain = yield* proof.validate();
                if (
                  chain.fingerprint !== proof.baseline.fingerprint ||
                  (yield* generation(Number(handle.pid))) !== initialGeneration ||
                  !(yield* handle.isRunning)
                )
                  return yield* refuse("identity_changed");
                return initialGeneration;
              }).pipe(
                Effect.timeout("200 millis"),
                Effect.catch((cause) =>
                  Effect.fail(
                    isHostObservationError(cause)
                      ? cause
                      : new HostObservationError({ reason: "capture_failed", cause }),
                  ),
                ),
                Effect.result,
              );
              if (captured._tag === "Failure") return inert(reasonOf(captured.failure));
              const pid = Number(handle.pid);
              let pinnedScope:
                | { path: string; identity: HostFileIdentity; key: string }
                | undefined;
              let invalid: Reason | undefined;
              const verify = () =>
                Effect.gen(function* () {
                  if (invalid !== undefined) return yield* refuse(invalid);
                  if (!(yield* handle.isRunning)) return yield* refuse("exited");
                  if (
                    (yield* generation(pid)) !== captured.success ||
                    (yield* boot()) !== proof.callerBoot ||
                    (yield* mount()) !== proof.mount
                  )
                    return yield* refuse("identity_changed");
                  if ((yield* proof.validate()).fingerprint !== proof.baseline.fingerprint)
                    return yield* refuse("identity_changed");
                  const path = yield* cgroup(pid);
                  if (
                    !path.startsWith(proof.slice + "/") ||
                    !/^mesura-agent-codex-\d+-\d+\.scope$/.test(path.slice(proof.slice.length + 1))
                  )
                    return yield* refuse("ambient_cgroup");
                  const directory = "/sys/fs/cgroup" + path;
                  // The kernel hierarchy and every scope component must remain directories.
                  let current = "/sys/fs/cgroup";
                  if ((yield* io.metadata(current)).kind !== "directory")
                    return yield* refuse("identity_changed");
                  for (const part of path.split("/").filter(Boolean)) {
                    current += "/" + part;
                    if ((yield* io.metadata(current)).kind !== "directory")
                      return yield* refuse("identity_changed");
                  }
                  const identity = yield* io.metadata(directory);
                  const key = yield* fingerprint([
                    proof.callerBoot,
                    identity.device,
                    identity.inode,
                  ]);
                  if (
                    pinnedScope !== undefined &&
                    (pinnedScope.path !== path ||
                      !(yield* identityEqual(pinnedScope.identity, identity)))
                  )
                    return yield* refuse("identity_changed");
                  const members = (yield* io.read(directory + "/cgroup.procs", 65536))
                    .trim()
                    .split("\n");
                  if (
                    members.some((member) => !/^\d+$/.test(member)) ||
                    !members.includes(String(pid))
                  )
                    return yield* refuse("identity_changed");
                  if (
                    !(yield* handle.isRunning) ||
                    (yield* generation(pid)) !== captured.success ||
                    (yield* cgroup(pid)) !== path
                  )
                    return yield* refuse("identity_changed");
                  pinnedScope ??= { path, identity, key };
                  return { directory, key };
                }).pipe(
                  Effect.catch((cause) => {
                    const reason = isHostObservationError(cause)
                      ? reasonOf(cause)
                      : "sample_failed";
                    // A transient pre-protocol exec may not yet enter its final scope. Never
                    // replace the process generation or recover a broken source identity.
                    if (reason !== "ambient_cgroup") invalid = reason;
                    return refuse(reason);
                  }),
                );
              const readLaunchDescriptor = verify().pipe(
                Effect.map(({ key }): ProviderAdapter.ProviderRuntimeLaunchDescriptor => ({
                  status: "verified",
                  verifiedScopeKey: key,
                })),
                Effect.catch((error) => Effect.succeed(failureDescriptor(reasonOf(error)))),
              );
              const readAnonymousMemory = Effect.gen(function* () {
                const before = yield* verify();
                const exe = yield* io.readLink(`/proc/${pid}/exe`);
                const executable = yield* trusted(exe);
                if (
                  executable.canonical !== proof.baseline.node.canonical ||
                  !(yield* identityEqual(
                    executable.records.at(-1)![1],
                    proof.baseline.node.records.at(-1)![1],
                  ))
                )
                  return yield* refuse("identity_changed");
                const stat = yield* io.read(before.directory + "/memory.stat", 65536);
                const current = parseCounter(
                  (yield* io.read(before.directory + "/memory.current", 128)).trim(),
                );
                const rows = stat
                  .trim()
                  .split("\n")
                  .map((line) => line.split(/\s+/));
                if (rows.some((row) => row.length !== 2 || parseCounter(row[1] ?? "") === null))
                  return yield* refuse("sample_failed");
                const anon = rows.filter((row) => row[0] === "anon");
                const bytes = anon.length === 1 ? parseCounter(anon[0]![1]!) : null;
                if (bytes === null || current === null) return yield* refuse("sample_failed");
                const after = yield* verify();
                if (after.key !== before.key || (yield* io.readLink(`/proc/${pid}/exe`)) !== exe)
                  return yield* refuse("identity_changed");
                return {
                  status: "available" as const,
                  verifiedScopeKey: before.key,
                  anonymousBytes: bytes,
                  sampledAt: DateTime.formatIso(yield* DateTime.now),
                };
              }).pipe(
                Effect.catch((error) => {
                  const reason = reasonOf(error);
                  if (
                    reason === "identity_changed" ||
                    reason === "exited" ||
                    reason === "untrusted_chain" ||
                    reason === "unknown_launcher"
                  )
                    invalid = reason;
                  return Effect.succeed(failureMemory(reason));
                }),
              );
              return Object.freeze({ launchToken, readLaunchDescriptor, readAnonymousMemory });
            }),
        };
      });
    return ProviderRuntimeHost.of({ prepare });
  });

export const layerUnsupported = Layer.effect(
  ProviderRuntimeHost,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return ProviderRuntimeHost.of({
      prepare: () =>
        Effect.succeed({
          capture: () =>
            crypto.randomUUIDv4.pipe(
              Effect.orDie,
              Effect.map((launchToken) =>
                Object.freeze({
                  launchToken,
                  readLaunchDescriptor: Effect.succeed(failureDescriptor("unknown_launcher")),
                  readAnonymousMemory: Effect.succeed(failureMemory("unknown_launcher")),
                }),
              ),
            ),
        }),
    });
  }),
).pipe(Layer.provide(NodeCrypto.layer));

export const layerWithDescription = (description: Description | undefined) =>
  Layer.effect(ProviderRuntimeHost, make(description)).pipe(
    Layer.provide([NodePath.layer, NodeCrypto.layer]),
  );

const layerIO = Layer.effect(
  ProviderRuntimeHostIO,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const callerUid = (yield* HostProcess.UserId) ?? -1;
    const cwd = yield* HostProcess.WorkingDirectory;
    const attempt = <A>(body: () => Promise<A>) =>
      Effect.tryPromise({
        try: body,
        catch: (cause) =>
          new HostObservationError({
            reason:
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
                ? "missing"
                : "sample_failed",
            cause,
          }),
      });
    return ProviderRuntimeHostIO.of({
      platform,
      arch,
      callerPid: process.pid,
      callerUid,
      cwd,
      metadata: (path) =>
        attempt(async () => {
          const info = await NodeFSP.lstat(path, { bigint: true });
          return {
            kind: info.isSymbolicLink()
              ? "link"
              : info.isDirectory()
                ? "directory"
                : info.isFile()
                  ? "file"
                  : info.isSocket()
                    ? "socket"
                    : "other",
            uid: Number(info.uid),
            mode: Number(info.mode),
            device: String(info.dev),
            inode: String(info.ino),
            size: Number(info.size),
            modified: String(info.mtimeNs),
          } satisfies HostFileIdentity;
        }),
      readLink: (path) => attempt(() => NodeFSP.readlink(path)),
      read: (path, limit) =>
        attempt(async () => {
          const handle = await NodeFSP.open(
            path,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
          );
          try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile()) throw new Error("unsupported file");
            const buffer = Buffer.alloc(limit + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > limit) throw new Error("bounded read exceeded");
            const after = await handle.stat({ bigint: true });
            const named = await NodeFSP.lstat(path, { bigint: true });
            if (
              before.dev !== after.dev ||
              before.ino !== after.ino ||
              before.size !== after.size ||
              before.mtimeNs !== after.mtimeNs ||
              named.dev !== after.dev ||
              named.ino !== after.ino
            )
              throw new Error("file identity changed");
            return buffer.subarray(0, bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
        }),
    });
  }),
);

export const layerKnownMesuraCodex = layerWithDescription(knownMesuraCodexLauncher).pipe(
  Layer.provide(layerIO),
);
