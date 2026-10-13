import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/process";
import * as Host from "./ProviderRuntimeHost.ts";
import { knownMesuraCodexLauncher as description } from "./knownMesuraCodexLauncher.ts";

// Exact reviewed source bytes are immutable injected fixtures, never host execution.
const helperBytes =
  '#!/bin/sh\n# Run a provider CLI in its own systemd scope when mesura-code.service spawns it.\n#\n# Installed on vigilia-home as /usr/local/bin/claude and /usr/local/bin/codex\n# (symlinks to this file). The server\'s PATH is /usr/local/bin:/usr/bin, so\n# these shadow the real binaries in /usr/bin without touching settings.json:\n# changing an instance\'s binaryPath makes the server rebuild that provider\n# instance, which closes every live session of it.\n#\n# Only processes inside mesura-code.service\'s own cgroup are moved; any other\n# caller (an SSH shell, an agent already in a scope) gets the real binary\n# unchanged. `systemd-run --scope` execs in place, so the server keeps the\n# PID, stdio and exit status it expects.\n#\n# Per scope (vigilia resource plan 6.2, per-scope part):\n#   OOMPolicy=continue  an OOM kill of one descendant (a dev server, a tsc)\n#                       must not stop the scope and with it the agent. It\n#                       leaves memory.oom.group at 0, so the kernel kills one\n#                       process, the one with the highest oom_score: mostly\n#                       the one with the most memory, which can be the agent\n#                       CLI itself. The scope survives; the CLI may not.\n#   MemoryMax=8G        the hard limit: past it the kernel kills inside this\n#   MemorySwapMax=1G    scope only. Without the swap cap the kernel never\n#                       kills there: reclaim swaps the excess to zram and the\n#                       scope thrashes (2026-10-04 mode).\n#   no MemoryHigh       a MemoryHigh below MemoryMax throttles the process\n#                       before it reaches the hard limit, and with no swap\n#                       left it stalls there instead of being killed. Until\n#                       2026-10-11 every scope had MemoryHigh=6G; a build\n#                       thrashing at it showed only 17-33% "full" pressure,\n#                       below systemd-oomd\'s 60% on the slice (Phase 5 review\n#                       P1-1), so nothing ended it. The soft brake is the\n#                       slice\'s (MemoryHigh 20G, MemoryMax 22G) plus oomd.\n#   Measured 2026-10-11 (kernel 7.2.0-rc1, swap available), a 512M child in\n#   a scope at the same limits divided by 32:\n#     MemoryHigh=192M MemoryMax=256M [MemorySwapMax=0 or 128M] -> no kill:\n#       it swaps out and finishes, or stalls at MemoryHigh for 60 s\n#     MemoryMax=256M                     -> no kill: it swaps out and finishes\n#     MemoryMax=256M MemorySwapMax=128M  -> oom_kill in 1 s, the agent lives\n#   tests/test-agent-scope-live.sh proves it on vigilia through this file.\n#   The cap bounds one session, not the slice: three scopes at 7.4G (22.2G)\n#   reach the slice\'s 20G/22G before any reaches 8G, and the slice\'s OOM or\n#   oomd then picks among all sessions. An aggregate budget (admission or\n#   concurrency limit, the typecheck lock) is plan item 6.2\'s remaining work\n#   and 6.4 (Phase 6 review P1-1, deferred).\n#   Long-lived workloads belong in mesura-workload-* units\n#   (mesura-agent-service), which carry their own cap.\n# --expand-environment=no: systemd-run otherwise expands ${VAR} and $$ in the\n#   command after `--` (systemd 261 on vigilia: `${HOME}` became /home/dev,\n#   `$$` became `$`), so a provider argument holding JSON or a prompt with `$`\n#   reached the CLI changed.\n# Why the slice exists: ~/.config/systemd/user/mesura-agents.slice.\n#\n# Remove: sudo rm /usr/local/bin/claude /usr/local/bin/codex /usr/local/lib/mesura-agent-scope\ntool=$(basename "$0")\nreal="/usr/bin/$tool"\n\ncase "$(cat /proc/self/cgroup 2>/dev/null)" in\n  */app.slice/mesura-code.service) ;;\n  *) exec "$real" "$@" ;;\nesac\n\n# The server\'s own short calls stay in the server\'s cgroup: they are probes\n# with 4-25 s budgets, and inside mesura-agents.slice they stall whenever the\n# agents are throttled at its MemoryHigh.\n#\n# MESURA_PROVIDER_PROBE=1 is the explicit signal for short-lived provider\n# spawns. It is the only way to tell a Codex status or skills probe from a\n# session, because both run `codex app-server` with the same argv\n# (2026-09-29 18:30: the probes timed out in the saturated slice and new\n# sessions hung in "starting").\n# Not yet effective: no deployed server sets it. Rollout phase 3 (a\n# mesura-code PR plus a server upgrade) adds it to the Codex app-server probes\n# and the Claude SDK probe queries. Until then Codex probes still get a scope\n# in mesura-agents.slice and can time out when the slice is saturated.\nif [ "${MESURA_PROVIDER_PROBE:-}" = 1 ]; then\n  exec "$real" "$@"\nfi\n\n# Argv fallbacks for servers built before MESURA_PROVIDER_PROBE existed.\n# Remove once every environment runs a server that sets the marker.\n#   --version                  health probe (claude, codex)\n#   --no-session-persistence   Claude SDK queries with persistSession: false\n#                              (capabilities probe, account limits)\n#   --ephemeral                codex exec for text generation\ncase "${1:-}" in\n  --version | -v | -V) exec "$real" "$@" ;;\nesac\nfor argument in "$@"; do\n  case "$argument" in\n    --no-session-persistence | --ephemeral) exec "$real" "$@" ;;\n  esac\ndone\n\nbus="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus"\nif [ ! -S "$bus" ]; then\n  exec "$real" "$@"\nfi\n\nexec systemd-run --user --scope --quiet --collect --expand-environment=no \\\n  --slice=mesura-agents.slice \\\n  -p OOMPolicy=continue -p MemoryMax=8G -p MemorySwapMax=1G \\\n  --unit="mesura-agent-$tool-$(date +%s%N)-$$" \\\n  -- "$real" "$@"\n';
const nodeBytes =
  '#!/usr/bin/env node\n// Unified entry point for the Codex CLI.\n\nimport { spawn } from "node:child_process";\nimport { existsSync, readFileSync, realpathSync } from "fs";\nimport { createRequire } from "node:module";\nimport path from "path";\nimport { fileURLToPath } from "url";\n\n// __dirname equivalent in ESM\nconst __filename = fileURLToPath(import.meta.url);\nconst __dirname = path.dirname(__filename);\nconst require = createRequire(import.meta.url);\nconst codexPackageRoot = realpathSync(path.join(__dirname, ".."));\n\nconst PLATFORM_PACKAGE_BY_TARGET = {\n  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",\n  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",\n  "x86_64-apple-darwin": "@openai/codex-darwin-x64",\n  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",\n  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",\n  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",\n};\n\nconst { platform, arch } = process;\n\nlet targetTriple = null;\nswitch (platform) {\n  case "linux":\n  case "android":\n    switch (arch) {\n      case "x64":\n        targetTriple = "x86_64-unknown-linux-musl";\n        break;\n      case "arm64":\n        targetTriple = "aarch64-unknown-linux-musl";\n        break;\n      default:\n        break;\n    }\n    break;\n  case "darwin":\n    switch (arch) {\n      case "x64":\n        targetTriple = "x86_64-apple-darwin";\n        break;\n      case "arm64":\n        targetTriple = "aarch64-apple-darwin";\n        break;\n      default:\n        break;\n    }\n    break;\n  case "win32":\n    switch (arch) {\n      case "x64":\n        targetTriple = "x86_64-pc-windows-msvc";\n        break;\n      case "arm64":\n        targetTriple = "aarch64-pc-windows-msvc";\n        break;\n      default:\n        break;\n    }\n    break;\n  default:\n    break;\n}\n\nif (!targetTriple) {\n  throw new Error(`Unsupported platform: ${platform} (${arch})`);\n}\n\nconst platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];\nif (!platformPackage) {\n  throw new Error(`Unsupported target triple: ${targetTriple}`);\n}\n\nfunction findCodexExecutable() {\n  let vendorRoot;\n  try {\n    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);\n    vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");\n  } catch {\n    vendorRoot = path.join(__dirname, "..", "vendor");\n  }\n\n  const codexExecutable = path.join(\n    vendorRoot,\n    targetTriple,\n    "bin",\n    process.platform === "win32" ? "codex.exe" : "codex",\n  );\n  if (existsSync(codexExecutable)) {\n    return codexExecutable;\n  }\n\n  const packageManager = detectPackageManager();\n  const updateCommand =\n    packageManager === "bun"\n      ? "bun install -g @openai/codex@latest"\n      : packageManager === "pnpm"\n        ? "pnpm add -g @openai/codex@latest"\n        : packageManager === "vite-plus"\n          ? "vp install -g @openai/codex@latest"\n          : "npm install -g @openai/codex@latest";\n  throw new Error(\n    `Missing optional dependency ${platformPackage}. Reinstall Codex: ${updateCommand}`,\n  );\n}\n\nconst binaryPath = findCodexExecutable();\n\n// Use an asynchronous spawn instead of spawnSync so that Node is able to\n// respond to signals (e.g. Ctrl-C / SIGINT) while the native binary is\n// executing. This allows us to forward those signals to the child process\n// and guarantees that when either the child terminates or the parent\n// receives a fatal signal, both processes exit in a predictable manner.\n\nfunction isPnpmOwnedCodexInstall(nodeModulesDir) {\n  if (!existsSync(path.join(nodeModulesDir, ".modules.yaml"))) {\n    return false;\n  }\n\n  try {\n    return (\n      realpathSync(path.join(nodeModulesDir, "@openai", "codex")) ===\n      codexPackageRoot\n    );\n  } catch {\n    return false;\n  }\n}\n\nfunction isVitePlusOwnedCodexInstall(packagesDir) {\n  if (path.basename(packagesDir) !== "packages") {\n    return false;\n  }\n\n  try {\n    const metadata = JSON.parse(\n      readFileSync(path.join(packagesDir, "@openai", "codex.json"), "utf8"),\n    );\n    if (metadata.name !== "@openai/codex") {\n      return false;\n    }\n\n    // Vite+ records the active global installation in packages/@openai/codex.json.\n    // Older installs have no ID or append a #-prefixed ID to the package name;\n    // newer installs put the ID in a subdirectory of the package prefix.\n    const installId = metadata.installId || "";\n    const installDir = installId.startsWith("#")\n      ? path.join(packagesDir, `@openai/codex${installId}`)\n      : path.join(packagesDir, "@openai/codex", installId);\n    for (const nodeModulesDir of [\n      path.join(installDir, "lib", "node_modules"),\n      path.join(installDir, "node_modules"),\n    ]) {\n      const packageRoot = path.join(nodeModulesDir, "@openai", "codex");\n      if (\n        existsSync(packageRoot) &&\n        realpathSync(packageRoot) === codexPackageRoot\n      ) {\n        return true;\n      }\n    }\n  } catch {\n    // Missing or unreadable ownership metadata must not prevent Codex starting.\n  }\n  return false;\n}\n\n/**\n * Use heuristics to detect the package manager that was used to install Codex\n * in order to give the user a hint about how to update it.\n */\nfunction detectPackageManager() {\n  // Package-manager ownership metadata can be several parents above the package.\n  // Search ancestors of both the canonical package root and lexical entrypoint\n  // because the package manager may link either path.\n  const entrypointDir = path.dirname(path.resolve(process.argv[1]));\n  for (const startDir of new Set([codexPackageRoot, entrypointDir])) {\n    const filesystemRoot = path.parse(startDir).root;\n    for (\n      let currentDir = startDir;\n      currentDir !== filesystemRoot;\n      currentDir = path.dirname(currentDir)\n    ) {\n      if (isVitePlusOwnedCodexInstall(currentDir)) {\n        return "vite-plus";\n      }\n      if (isPnpmOwnedCodexInstall(path.join(currentDir, "node_modules"))) {\n        return "pnpm";\n      }\n    }\n\n    if (isPnpmOwnedCodexInstall(path.join(filesystemRoot, "node_modules"))) {\n      return "pnpm";\n    }\n  }\n\n  const userAgent = process.env.npm_config_user_agent || "";\n  if (/\\bbun\\//.test(userAgent)) {\n    return "bun";\n  }\n\n  const execPath = process.env.npm_execpath || "";\n  if (execPath.includes("bun")) {\n    return "bun";\n  }\n\n  if (\n    __dirname.includes(".bun/install/global") ||\n    __dirname.includes(".bun\\\\install\\\\global")\n  ) {\n    return "bun";\n  }\n\n  return userAgent ? "npm" : null;\n}\n\nconst packageManager = detectPackageManager();\nconst packageManagerEnvVar =\n  packageManager === "bun"\n    ? "CODEX_MANAGED_BY_BUN"\n    : packageManager === "pnpm"\n      ? "CODEX_MANAGED_BY_PNPM"\n      : packageManager === "vite-plus"\n        ? "CODEX_MANAGED_BY_VITE_PLUS"\n        : "CODEX_MANAGED_BY_NPM";\nconst env = {\n  ...process.env,\n  CODEX_MANAGED_PACKAGE_ROOT: codexPackageRoot,\n};\ndelete env.CODEX_MANAGED_BY_NPM;\ndelete env.CODEX_MANAGED_BY_BUN;\ndelete env.CODEX_MANAGED_BY_PNPM;\ndelete env.CODEX_MANAGED_BY_VITE_PLUS;\nenv[packageManagerEnvVar] = "1";\n\nconst child = spawn(binaryPath, process.argv.slice(2), {\n  stdio: "inherit",\n  env,\n});\n\nchild.on("error", (err) => {\n  // Typically triggered when the binary is missing or not executable.\n  // Re-throwing here will terminate the parent with a non-zero exit code\n  // while still printing a helpful stack trace.\n  // eslint-disable-next-line no-console\n  console.error(err);\n  process.exit(1);\n});\n\n// Forward common termination signals to the child so that it shuts down\n// gracefully. In the handler we temporarily disable the default behavior of\n// exiting immediately; once the child has been signaled we simply wait for\n// its exit event which will in turn terminate the parent (see below).\nconst forwardSignal = (signal) => {\n  if (child.killed) {\n    return;\n  }\n  try {\n    child.kill(signal);\n  } catch {\n    /* ignore */\n  }\n};\n\n["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {\n  process.on(sig, () => forwardSignal(sig));\n});\n\n// When the child exits, mirror its termination reason in the parent so that\n// shell scripts and other tooling observe the correct exit status.\n// Wrap the lifetime of the child process in a Promise so that we can await\n// its termination in a structured way. The Promise resolves with an object\n// describing how the child exited: either via exit code or due to a signal.\nconst childResult = await new Promise((resolve) => {\n  child.on("exit", (code, signal) => {\n    if (signal) {\n      resolve({ type: "signal", signal });\n    } else {\n      resolve({ type: "code", exitCode: code ?? 1 });\n    }\n  });\n});\n\nif (childResult.type === "signal") {\n  // Re-emit the same signal so that the parent terminates with the expected\n  // semantics (this also sets the correct exit code of 128 + n).\n  process.kill(process.pid, childResult.signal);\n} else {\n  process.exit(childResult.exitCode);\n}\n';

const bootId = "11111111-1111-1111-1111-111111111111";
const scope =
  "/user.slice/user-1000.slice/user@1000.service/mesura.slice/mesura-agents.slice/mesura-agent-codex-1234-42.scope";
const caller = "/user.slice/user-1000.slice/user@1000.service/app.slice/mesura-code.service";
const stat = (ticks = "100", state = "S") =>
  `42 (codex (launcher)) ${state} ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks} 0`;

function fixture() {
  const metadata = new Map<string, Host.HostFileIdentity>();
  const links = new Map<string, string>();
  const bytes = new Map<string, string>();
  let inode = 0;
  const put = (path: string, kind: Host.HostFileIdentity["kind"] = "file", mode = 0o755) => {
    const parts = path.split("/").filter(Boolean);
    let parent = "/";
    if (!metadata.has(parent))
      metadata.set(parent, {
        kind: "directory",
        uid: 0,
        mode: 0o755,
        device: "1",
        inode: String(++inode),
        size: 0,
        modified: "1",
      });
    for (const part of parts.slice(0, -1)) {
      parent = parent === "/" ? `/${part}` : `${parent}/${part}`;
      if (!metadata.has(parent))
        metadata.set(parent, {
          kind: "directory",
          uid: 0,
          mode: 0o755,
          device: "1",
          inode: String(++inode),
          size: 0,
          modified: "1",
        });
    }
    metadata.set(path, {
      kind,
      uid: 0,
      mode,
      device: "1",
      inode: String(++inode),
      size: 0,
      modified: "1",
    });
  };
  const link = (path: string, target: string) => {
    put(path, "link", 0o777);
    links.set(path, target);
  };
  put(description.helper);
  put(description.nodeSource);
  link(description.invocation, description.helper);
  link(description.realInvocation, "../lib/node_modules/@openai/codex/bin/codex.js");
  link("/bin/sh", "/usr/bin/bash");
  for (const utility of ["bash", "env", "basename", "cat", "id", "date", "systemd-run", "node"])
    put(`/usr/bin/${utility}`);
  put(description.platformPackage + "/package.json", "file", 0o644);
  put(description.platformPackage + "/" + description.nativeRelativePath);
  put("/run/user/1000/bus", "socket");
  put("/sys/fs/cgroup" + scope, "directory");
  bytes.set(description.helper, helperBytes);
  bytes.set(description.nodeSource, nodeBytes);
  bytes.set(description.platformPackage + "/package.json", '{"name":"@openai/codex-linux-x64"}');
  bytes.set("/proc/sys/kernel/random/boot_id", bootId + "\n");
  bytes.set("/proc/7/cgroup", `0::${caller}\n`);
  bytes.set("/proc/7/mountinfo", "29 20 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n");
  bytes.set("/proc/42/stat", stat());
  bytes.set("/proc/42/cgroup", `0::${scope}\n`);
  bytes.set("/sys/fs/cgroup" + scope + "/cgroup.procs", "42\n99\n");
  bytes.set("/sys/fs/cgroup" + scope + "/memory.stat", "anon 123\nfile 900\n");
  bytes.set("/sys/fs/cgroup" + scope + "/memory.current", "456\n");
  links.set("/proc/42/exe", "/usr/bin/node");
  let running = true;
  const handle: Pick<ChildProcessSpawner.ChildProcessHandle, "pid" | "isRunning"> = {
    pid: 42 as ChildProcessSpawner.ProcessId,
    isRunning: Effect.sync(() => running),
  };
  let onRead: ((path: string) => void) | undefined;
  const io = Host.ProviderRuntimeHostIO.of({
    platform: "linux",
    arch: "x64",
    callerPid: 7,
    callerUid: 1000,
    cwd: "/workspace",
    metadata: (path) =>
      Effect.suspend(() => {
        const value = metadata.get(path);
        return value === undefined
          ? Effect.fail(new Host.HostObservationError({ reason: "missing" }))
          : Effect.succeed(value);
      }),
    readLink: (path) =>
      Effect.suspend(() => {
        const value = links.get(path);
        return value === undefined
          ? Effect.fail(new Host.HostObservationError({ reason: "sample_failed" }))
          : Effect.succeed(value);
      }),
    read: (path, limit) =>
      Effect.suspend(() => {
        onRead?.(path);
        const value = bytes.get(path);
        return value === undefined || Buffer.byteLength(value) > limit
          ? Effect.fail(new Host.HostObservationError({ reason: "sample_failed" }))
          : Effect.succeed(value);
      }),
  });
  const layer = Host.layerWithDescription(description).pipe(
    Layer.provide(Layer.succeed(Host.ProviderRuntimeHostIO, io)),
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };
  const prepare = Effect.gen(function* () {
    const host = yield* Host.ProviderRuntimeHost;
    return yield* host.prepare({ command: "codex", args: ["app-server"], environment });
  }).pipe(Effect.provide(layer));
  return {
    metadata,
    links,
    bytes,
    put,
    environment,
    handle,
    prepare,
    layer,
    setRunning: (value: boolean) => {
      running = value;
    },
    setOnRead: (callback: typeof onRead) => {
      onRead = callback;
    },
  };
}

it.effect(
  "accepts the actual systemd slice hierarchy, exact sources and root-owned links, and reports full anon",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const observation = yield* (yield* f.prepare).capture(f.handle);
      assert.equal((yield* observation.readLaunchDescriptor).status, "verified");
      const sample = yield* observation.readAnonymousMemory;
      assert.equal(sample.status, "available");
      assert.equal(sample.anonymousBytes, 123);
      f.bytes.set("/sys/fs/cgroup" + scope + "/memory.stat", "anon 0\nfile 456\n");
      assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, 0);
    }),
);

it.effect.each([
  "/user.slice/user-1000.slice/user@1000.service/mesura-agents.slice/mesura-agent-codex-1234-42.scope",
  "/user.slice/user-1000.slice/user@1000.service/mesura.slice/mesura-workers.slice/mesura-agent-codex-1234-42.scope",
  "/user.slice/user-1000.slice/user@1000.service/app.slice/mesura-agent-codex-1234-42.scope",
  "/user.slice/user-2000.slice/user@2000.service/mesura.slice/mesura-agents.slice/mesura-agent-codex-1234-42.scope",
  scope + "/nested.scope",
  scope.replace("mesura-agents.slice/", "mesura-agents.slice-other/"),
])("refuses populated scopes outside the exact reviewed slice hierarchy %#", (candidate) =>
  Effect.gen(function* () {
    const f = fixture();
    f.put("/sys/fs/cgroup" + candidate, "directory");
    f.bytes.set("/proc/42/cgroup", `0::${candidate}\n`);
    f.bytes.set("/sys/fs/cgroup" + candidate + "/cgroup.procs", "42\n99\n");
    f.bytes.set("/sys/fs/cgroup" + candidate + "/memory.stat", "anon 123\nfile 900\n");
    f.bytes.set("/sys/fs/cgroup" + candidate + "/memory.current", "456\n");
    const observation = yield* (yield* f.prepare).capture(f.handle);
    const descriptor = yield* observation.readLaunchDescriptor;
    assert.equal(descriptor.status, "unsupported");
    if (descriptor.status !== "verified") assert.equal(descriptor.reason, "ambient_cgroup");
    const sample = yield* observation.readAnonymousMemory;
    assert.equal(sample.status, "unsupported");
    assert.equal(sample.anonymousBytes, null);
    assert.equal(sample.sampledAt, null);
  }),
);

it.effect.each([
  "helper source",
  "node source",
  "link owner",
  "ancestor mode",
  "utility",
  "node",
  "native",
  "package exports",
] as const)("rejects a changed %s without failing provider acquisition", (mutation) =>
  Effect.gen(function* () {
    const f = fixture();
    if (mutation === "helper source") f.bytes.set(description.helper, helperBytes + "\n");
    if (mutation === "node source") f.bytes.set(description.nodeSource, nodeBytes + "\n");
    if (mutation === "link owner")
      f.metadata.set(description.invocation, {
        ...f.metadata.get(description.invocation)!,
        uid: 1000,
      });
    if (mutation === "ancestor mode")
      f.metadata.set("/usr/local", { ...f.metadata.get("/usr/local")!, mode: 0o777 });
    if (mutation === "utility" || mutation === "node") {
      const name = mutation === "utility" ? "cat" : "node";
      f.put(`/usr/local/bin/${name}`);
      f.metadata.set(`/usr/local/bin/${name}`, {
        ...f.metadata.get(`/usr/local/bin/${name}`)!,
        uid: 1000,
      });
    }
    if (mutation === "native")
      f.metadata.set(description.platformPackage + "/" + description.nativeRelativePath, {
        ...f.metadata.get(description.platformPackage + "/" + description.nativeRelativePath)!,
        uid: 1000,
      });
    if (mutation === "package exports")
      f.bytes.set(
        description.platformPackage + "/package.json",
        '{"exports":{"./package.json":"../redirect.json"}}',
      );
    const observation = yield* (yield* f.prepare).capture(f.handle);
    assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
    assert.equal((yield* observation.readLaunchDescriptor).status, "unsupported");
  }),
);

it.effect.each([
  undefined,
  "",
  "/usr/local/bin::/usr/bin",
  "bin:/usr/bin",
  " /usr/local/bin:/usr/bin",
  "/usr/local/bin:/usr/bin:",
])("refuses unsupported PATH shape %s", (path) =>
  Effect.gen(function* () {
    const f = fixture();
    f.environment.PATH = path;
    const observation = yield* (yield* f.prepare).capture(f.handle);
    assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
    const descriptor = yield* observation.readLaunchDescriptor;
    assert.equal(descriptor.status, "unsupported");
    if (descriptor.status !== "verified") assert.equal(descriptor.reason, "unsupported_path");
  }),
);

it.effect(
  "refuses PATH aliases and preserves selected user-owned nvm Node instead of substituting system Node",
  () =>
    Effect.gen(function* () {
      for (const alias of [true, false]) {
        const f = fixture();
        if (alias) f.environment.Path = f.environment.PATH;
        else {
          f.environment.PATH = "/home/dev/nvm/bin:/usr/local/bin:/usr/bin";
          f.put("/home/dev/nvm/bin/node");
          f.metadata.set("/home/dev", { ...f.metadata.get("/home/dev")!, uid: 1000 });
        }
        assert.equal(
          (yield* (yield* (yield* f.prepare).capture(f.handle)).readAnonymousMemory).anonymousBytes,
          null,
        );
      }
    }),
);

it.effect(
  "binds post-spawn sources permanently and never adopts a replacement generation after failed capture",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const acquisition = yield* f.prepare;
      f.bytes.set(description.helper, helperBytes + " ");
      const observation = yield* acquisition.capture(f.handle);
      f.bytes.set(description.helper, helperBytes);
      f.bytes.set("/proc/42/stat", stat("200"));
      assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
      assert.equal((yield* observation.readLaunchDescriptor).status, "unsupported");
    }),
);

it.effect("rejects already exited and inaccessible captures permanently", () =>
  Effect.gen(function* () {
    for (const kind of ["exited", "inaccessible"] as const) {
      const f = fixture();
      const acquisition = yield* f.prepare;
      if (kind === "exited") f.setRunning(false);
      else f.bytes.delete("/proc/42/stat");
      const observation = yield* acquisition.capture(f.handle);
      f.setRunning(true);
      f.bytes.set("/proc/42/stat", stat());
      assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
    }
  }),
);

it.effect(
  "permits expected exec with unchanged start ticks, but refuses captured external parent or native executable",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const acquisition = yield* f.prepare;
      f.links.set("/proc/42/exe", "/usr/bin/bash");
      const observation = yield* acquisition.capture(f.handle);
      f.links.set("/proc/42/exe", "/usr/bin/node");
      assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, 123);
      for (const kind of ["external", "native"] as const) {
        const other = fixture();
        const observation = yield* (yield* other.prepare).capture(other.handle);
        if (kind === "external") other.bytes.set("/proc/42/cgroup", `0::${caller}\n`);
        else
          other.links.set(
            "/proc/42/exe",
            description.platformPackage + "/" + description.nativeRelativePath,
          );
        assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
      }
    }),
);

it.effect("refuses unknown/direct-native invocation and helper bypass conditions", () =>
  Effect.gen(function* () {
    const f = fixture();
    const host = yield* Host.ProviderRuntimeHost.pipe(Effect.provide(f.layer));
    for (const input of [
      { command: description.helper, args: ["app-server"], environment: f.environment },
      {
        command: description.platformPackage + "/" + description.nativeRelativePath,
        args: ["app-server"],
        environment: f.environment,
      },
      { command: "codex", args: ["app-server", "--ephemeral"], environment: f.environment },
      {
        command: "codex",
        args: ["app-server"],
        environment: { ...f.environment, MESURA_PROVIDER_PROBE: "1" },
      },
    ]) {
      assert.equal(
        (yield* (yield* (yield* host.prepare(input)).capture(f.handle)).readAnonymousMemory)
          .anonymousBytes,
        null,
      );
    }
  }),
);

it.effect.each(["boot", "ticks", "cgroup", "directory", "membership", "exit", "source"] as const)(
  "rejects %s drift during counter reading",
  (kind) =>
    Effect.gen(function* () {
      const f = fixture();
      const observation = yield* (yield* f.prepare).capture(f.handle);
      yield* observation.readLaunchDescriptor;
      f.setOnRead((path) => {
        if (!path.endsWith("/memory.stat")) return;
        if (kind === "boot")
          f.bytes.set("/proc/sys/kernel/random/boot_id", "22222222-2222-2222-2222-222222222222\n");
        if (kind === "ticks") f.bytes.set("/proc/42/stat", stat("200"));
        if (kind === "cgroup") f.bytes.set("/proc/42/cgroup", `0::${caller}\n`);
        if (kind === "directory")
          f.metadata.set("/sys/fs/cgroup" + scope, {
            ...f.metadata.get("/sys/fs/cgroup" + scope)!,
            inode: "replaced",
          });
        if (kind === "membership") f.bytes.set("/sys/fs/cgroup" + scope + "/cgroup.procs", "99\n");
        if (kind === "exit") f.setRunning(false);
        if (kind === "source") f.bytes.set(description.nodeSource, nodeBytes + " ");
      });
      assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
    }),
);

it.effect.each([
  "file 1\n",
  "anon -1\n",
  "anon 9007199254740992\n",
  "anon x\n",
  "anon 1\nanon 2\n",
  "anon 0\n" + "x".repeat(65536),
])("rejects malformed or unbounded anonymous counter %#", (counter) =>
  Effect.gen(function* () {
    const f = fixture();
    const observation = yield* (yield* f.prepare).capture(f.handle);
    f.bytes.set("/sys/fs/cgroup" + scope + "/memory.stat", counter);
    assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
  }),
);

it.effect("does not substitute current when anon is missing or current is malformed", () =>
  Effect.gen(function* () {
    const f = fixture();
    const observation = yield* (yield* f.prepare).capture(f.handle);
    f.bytes.set("/sys/fs/cgroup" + scope + "/memory.current", "invalid\n");
    assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
  }),
);

it.effect.each([
  "BASH_FUNC_date%%",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_COMPILE_CACHE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
])("refuses the effective environment bootstrap hook %s", (key) =>
  Effect.gen(function* () {
    const f = fixture();
    f.environment[key] = "injected";
    const observation = yield* (yield* f.prepare).capture(f.handle);
    assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
    const result = yield* observation.readLaunchDescriptor;
    if (result.status !== "verified") assert.equal(result.reason, "untrusted_chain");
    else assert.fail("an injected executable chain qualified");
  }),
);

it.effect.each(["node", "date", "systemd-run"])(
  "rejects a root-owned redirect of selected %s to another executable",
  (utility) =>
    Effect.gen(function* () {
      const f = fixture();
      f.put(`/usr/local/bin/${utility}`, "link", 0o777);
      f.links.set(`/usr/local/bin/${utility}`, "/usr/bin/bash");
      const observation = yield* (yield* f.prepare).capture(f.handle);
      assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
      const result = yield* observation.readLaunchDescriptor;
      assert.equal(result.status, "unsupported");
    }),
);

it.effect("refuses a caller outside the eligible service and an absent user bus", () =>
  Effect.gen(function* () {
    for (const kind of ["caller", "bus"] as const) {
      const f = fixture();
      if (kind === "caller") f.bytes.set("/proc/7/cgroup", "0::/app.slice/unrelated.service\n");
      else f.metadata.delete("/run/user/1000/bus");
      assert.equal(
        (yield* (yield* (yield* f.prepare).capture(f.handle)).readAnonymousMemory).anonymousBytes,
        null,
      );
    }
  }),
);

it.effect("binds the authoritative cgroup2 mount and rejects mount changes", () =>
  Effect.gen(function* () {
    const f = fixture();
    const observation = yield* (yield* f.prepare).capture(f.handle);
    assert.equal((yield* observation.readLaunchDescriptor).status, "verified");
    f.bytes.set("/proc/7/mountinfo", "30 20 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n");
    assert.equal((yield* observation.readAnonymousMemory).anonymousBytes, null);
    const another = fixture();
    another.bytes.set(
      "/proc/7/mountinfo",
      "29 20 0:28 /subtree /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
    );
    assert.equal(
      (yield* (yield* (yield* another.prepare).capture(another.handle)).readAnonymousMemory)
        .anonymousBytes,
      null,
    );
  }),
);
