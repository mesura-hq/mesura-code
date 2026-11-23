// Entry points: channel.ts CLI dispatch and the staged launcher.sh (substitute @CHANNEL@ with dev or lab).
// Expected exports: parseChannelArgs (channel.ts), planBuild (build.ts), planStage (stage.ts),
// planLabReset and copyLabAuthRows (lab-reset.ts), planConnect and formatPairingUrl (connect.ts).
// Phase 4 expects decideFollowDevTick(state, observations) and runFollowDevTick(options) from follow-dev.ts.
// @effect-diagnostics nodeBuiltinImport:off - The launcher subprocess and SQLite tests use disposable host files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";

import type { BuildArtifact, BuildInput } from "./build.ts";

const deployHome = "/fixture/vigilia";
const laptopHome = "/fixture/laptop";
const laptopTarget = "fixture@laptop";
const laptopTailnetName = "laptop.example.ts.net";
const phonePorts = new Map([
  ["dev", 8783],
  ["lab", 8793],
]);
const stageInput = {
  appImagePath: "/fixture/artifacts/fixture.AppImage",
  sha256: "d".repeat(64),
  laptopHome,
  laptopTarget,
};
const revision = "topic/lab-fixture";
const labHome = NodePath.join(laptopHome, ".mesura-code-channel-lab");
const labState = NodePath.join(labHome, "userdata");
const labFiles = [
  "statev2.sqlite",
  "statev2.sqlite-wal",
  "statev2.sqlite-shm",
  "state.sqlite",
  "state.sqlite-journal",
  "state.sqlite-wal",
  "state.sqlite-shm",
  "environment-id",
  "secrets",
  "settings.json",
  "keybindings.json",
];
const labInput = { revision, laptopHome, laptopTarget, stateEntries: labFiles };

const stableLauncher = NodePath.join(laptopHome, ".local/bin/mesura-sync-test");
const devLauncher = NodePath.join(laptopHome, ".local/bin/mesura-code-dev");
const labLauncher = NodePath.join(laptopHome, ".local/bin/mesura-code-lab");
const connectInput = {
  laptopHome,
  laptopTailnetName,
  laptopTarget,
  vigiliaOrigin: "https://vigilia.example.ts.net",
  clients: [
    { channel: "stable", launcher: stableLauncher, savedEnvironmentNames: ["Mesura Code Dev"] },
    { channel: "dev", launcher: devLauncher, savedEnvironmentNames: ["vigilia-home"] },
    { channel: "lab", launcher: labLauncher, savedEnvironmentNames: [] },
  ],
} as const;

it("phase 3 plans an isolated channel build and verifies both Electron copies before reporting the artifact", async () => {
  const { planBuild } = await import("./build.ts");

  for (const channel of ["dev", "lab"] as const) {
    const plan = planBuild({ channel, revision, deployHome });
    expect(NodePath.isAbsolute(plan.worktree)).toBe(true);
    expect(plan.worktree).not.toMatch(
      /^\/opt\/dev\/(?:deploy\/mesura-code-v012|repos\/mesura-code)(?:\/|$)/,
    );
    expect(plan).toMatchObject({
      workload: "mesura-agent-service",
      lockPath: "/tmp/mesura-channel-build.lock",
      steps: [
        { kind: "checkout", revision },
        { kind: "select-node", versionFile: NodePath.join(plan.worktree, ".nvmrc") },
        { kind: "install", args: ["install", "--frozen-lockfile"] },
        { kind: "verify-extracted-electron" },
        {
          kind: "package",
          args: expect.arrayContaining(["--channel", channel, "--target", "AppImage"]),
        },
        { kind: "verify-packed-electron" },
        { kind: "report-artifact", fields: ["path", "sha256"] },
      ],
    });
  }
});

it("phase 3 stages each channel's next image and launcher and checks the full hash on the laptop", async () => {
  const { planStage } = await import("./stage.ts");

  for (const [channel, title] of [
    ["dev", "Dev"],
    ["lab", "Lab"],
  ] as const) {
    const remoteImage = NodePath.join(
      laptopHome,
      "Applications",
      `Mesura-Code-${title}.next.AppImage`,
    );
    const plan = planStage({ ...stageInput, channel });
    expect(plan).toMatchObject({
      target: laptopTarget,
      appImage: { source: stageInput.appImagePath, destination: remoteImage },
      launcher: {
        channel,
        destination: NodePath.join(laptopHome, ".local/bin", `mesura-code-${channel}`),
      },
      verify: { target: laptopTarget, path: remoteImage, sha256: stageInput.sha256 },
    });
    expect(plan.writePaths).toEqual(
      expect.arrayContaining([remoteImage, plan.launcher.destination]),
    );
  }
});

it("phase 3 activates a staged AppImage before execution and keeps the rollback on the next launch", () => {
  using home = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-channel-launcher-"),
  );
  const template = NodeFS.readFileSync(new URL("./launcher.sh", import.meta.url), "utf8");
  const applications = NodePath.join(home.path, "Applications");
  NodeFS.mkdirSync(applications);
  const launcher = NodePath.join(home.path, "launcher");
  const current = NodePath.join(applications, "Mesura-Code-Dev.AppImage");
  const staged = NodePath.join(applications, "Mesura-Code-Dev.next.AppImage");
  const previous = `${current}.prev`;
  const invocation = NodePath.join(home.path, "invocation");
  const originalImage = "#!/bin/sh\nexit 97\n";
  const stagedImage = [
    "#!/bin/sh",
    'test -f "$0.prev" || exit 10',
    'test ! -e "$HOME/Applications/Mesura-Code-Dev.next.AppImage" || exit 11',
    "env | grep -q '^XDG_' && exit 12",
    "env | grep -Eq '^(ELECTRON_RUN_AS_NODE|APPIMAGE|APPDIR|ARGV0|OWD|LD_LIBRARY_PATH)=' && exit 13",
    'printf \'%s\\n\' "$@" > "$HOME/invocation"',
  ].join("\n");
  NodeFS.writeFileSync(launcher, template.replaceAll("@CHANNEL@", "dev"), { mode: 0o755 });
  NodeFS.writeFileSync(current, originalImage, { mode: 0o755 });
  NodeFS.writeFileSync(staged, stagedImage, { mode: 0o755 });

  for (const argument of ["t3code://pair?pairingUrl=fixture", "argument with spaces"]) {
    const result = NodeChildProcess.spawnSync(launcher, [argument], {
      cwd: home.path,
      encoding: "utf8",
      env: {
        HOME: home.path,
        PATH: "/usr/bin:/bin",
        ELECTRON_RUN_AS_NODE: "1",
        APPIMAGE: "parent",
        APPDIR: "/fixture/appdir",
        ARGV0: "parent-launcher",
        OWD: "/fixture",
        LD_LIBRARY_PATH: "/fixture/lib",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.readFileSync(invocation, "utf8")).toBe(`${argument}\n`);
    expect(NodeFS.readFileSync(current, "utf8")).toBe(stagedImage);
    expect(NodeFS.readFileSync(previous, "utf8")).toBe(originalImage);
    expect(NodeFS.existsSync(staged)).toBe(false);
  }
});

it("phase 3 stages Lab before quitting it and relaunches only after recreating its database", async () => {
  const { planLabReset } = await import("./lab-reset.ts");

  expect(planLabReset(labInput).steps).toMatchObject([
    { kind: "build", channel: "lab", revision },
    { kind: "stage", channel: "lab", target: laptopTarget },
    {
      kind: "quit",
      target: laptopTarget,
      appImage: NodePath.join(laptopHome, "Applications/Mesura-Code-Lab.AppImage"),
      processLookup: "fuse-mount",
    },
    { kind: "backup-db", source: NodePath.join(labState, "statev2.sqlite") },
    { kind: "remove-worktrees", directory: NodePath.join(labHome, "worktrees") },
    {
      kind: "delete-databases",
      paths: expect.arrayContaining([
        NodePath.join(labState, "state.sqlite"),
        NodePath.join(labState, "statev2.sqlite"),
      ]),
    },
    { kind: "migrate-db", baseDir: labHome },
    { kind: "restore-auth", destination: NodePath.join(labState, "statev2.sqlite") },
    {
      kind: "relaunch",
      executable: labLauncher,
      readinessUrl: "http://127.0.0.1:3793/.well-known/t3/environment",
    },
  ]);
});

it("phase 3 keeps Lab identity files and copies only shared columns of the four sign-in tables", async () => {
  const { copyLabAuthRows, planLabReset } = await import("./lab-reset.ts");
  const { steps, writePaths } = planLabReset(labInput);
  const databasePaths = [
    "state.sqlite",
    "state.sqlite-journal",
    "state.sqlite-shm",
    "state.sqlite-wal",
    "statev2.sqlite",
    "statev2.sqlite-shm",
    "statev2.sqlite-wal",
  ].map((name) => NodePath.join(labState, name));
  const deleteStep = steps.find((step: { kind: string }) => step.kind === "delete-databases");
  if (deleteStep?.kind !== "delete-databases") throw new Error("Missing database deletion step");
  expect([...deleteStep.paths].sort()).toEqual(databasePaths);
  for (const file of ["environment-id", "secrets", "settings.json", "keybindings.json"]) {
    expect(writePaths).not.toContain(NodePath.join(labState, file));
  }

  using scratch = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-channel-auth-"),
  );
  const sourcePath = NodePath.join(scratch.path, "backup.sqlite");
  const destinationPath = NodePath.join(scratch.path, "fresh.sqlite");
  const authTables = [
    "auth_sessions",
    "auth_pairing_links",
    "mesura_mcp_refresh_tokens",
    "peer_environment_links",
  ];
  {
    using source = new NodeSqlite.DatabaseSync(sourcePath);
    using destination = new NodeSqlite.DatabaseSync(destinationPath);
    for (const table of [...authTables, "threads"]) {
      source.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT, old_column TEXT)`);
      source.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(1, `${table}-first`, "dropped");
      source.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(2, null, "also dropped");
      destination.exec(
        `CREATE TABLE ${table} (value TEXT, new_column TEXT NOT NULL DEFAULT 'fresh', id INTEGER PRIMARY KEY)`,
      );
    }
  }

  await copyLabAuthRows(sourcePath, destinationPath);

  using restored = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
  for (const table of authTables) {
    expect(restored.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual([
      { id: 1, value: `${table}-first`, new_column: "fresh" },
      { id: 2, value: null, new_column: "fresh" },
    ]);
  }
  expect(restored.prepare("SELECT * FROM threads").all()).toEqual([]);
});

it("phase 3 requests a separate one-time pairing for each missing desktop environment and targets its own launcher", async () => {
  const { planConnect, formatPairingUrl } = await import("./connect.ts");
  const { desktopPairings } = planConnect(connectInput);
  expect(desktopPairings).toHaveLength(7);
  expect(desktopPairings).toEqual(
    expect.arrayContaining(
      [
        {
          executable: stableLauncher,
          server: "lab",
          origin: "http://127.0.0.1:3793",
          oneTime: true,
        },
        {
          executable: stableLauncher,
          server: "vigilia",
          origin: connectInput.vigiliaOrigin,
          oneTime: true,
        },
        {
          executable: devLauncher,
          server: "stable",
          origin: "http://127.0.0.1:3773",
          oneTime: true,
        },
        { executable: devLauncher, server: "lab", origin: "http://127.0.0.1:3793", oneTime: true },
        {
          executable: labLauncher,
          server: "stable",
          origin: "http://127.0.0.1:3773",
          oneTime: true,
        },
        { executable: labLauncher, server: "dev", origin: "http://127.0.0.1:3783", oneTime: true },
        {
          executable: labLauncher,
          server: "vigilia",
          origin: connectInput.vigiliaOrigin,
          oneTime: true,
        },
      ].map((request) => expect.objectContaining(request)),
    ),
  );

  for (const pairing of desktopPairings) {
    const link = new URL(formatPairingUrl(pairing, "desktop+fixture", "desktop"));
    expect([link.protocol, link.hostname]).toEqual(["t3code:", "pair"]);
    const pairingUrl = new URL(link.searchParams.get("pairingUrl") ?? "");
    expect(pairingUrl.origin).toBe(pairing.origin);
    expect(pairingUrl.pathname).toBe("/pair");
    expect(new URLSearchParams(pairingUrl.hash.slice(1)).get("token")).toBe("desktop+fixture");
  }
});

it("phase 3 prepares Dev and Lab phone pairing URLs through their laptop Tailscale ports", async () => {
  const { planConnect, formatPairingUrl } = await import("./connect.ts");
  const { phonePairings } = planConnect(connectInput);

  expect(phonePairings).toHaveLength(2);
  for (const pairing of phonePairings) {
    const port = phonePorts.get(pairing.server);
    expect(port).toBeDefined();
    const url = new URL(formatPairingUrl(pairing, `phone+${pairing.server}`, "phone"));
    expect(url.origin).toBe(`https://${laptopTailnetName}:${port}`);
    expect(url.pathname).toBe("/pair");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(`phone+${pairing.server}`);
  }
  expect(new Set(phonePairings.map(({ server }: { server: string }) => server))).toEqual(
    new Set(["dev", "lab"]),
  );
});

it("phase 3 excludes both stable homes and their descendants from every channel command's direct write paths", async () => {
  const { planBuild } = await import("./build.ts");
  const { planStage } = await import("./stage.ts");
  const { planLabReset } = await import("./lab-reset.ts");
  const { planConnect } = await import("./connect.ts");
  const stableHomes = [
    NodePath.join(deployHome, ".mesura-code"),
    NodePath.join(laptopHome, ".local/state/mesura-sync-v046-test"),
  ];
  const channelPlans = (["dev", "lab"] as const).flatMap((channel) => [
    planBuild({ channel, revision, deployHome }),
    planStage({ ...stageInput, channel }),
  ]);

  for (const plan of [...channelPlans, planLabReset(labInput), planConnect(connectInput)]) {
    expect(Array.isArray(plan.writePaths)).toBe(true);
    for (const destination of plan.writePaths) {
      expect(NodePath.isAbsolute(destination), destination).toBe(true);
      for (const home of stableHomes) {
        const pathFromHome = NodePath.relative(home, destination);
        expect(
          pathFromHome === ".." ||
            pathFromHome.startsWith("../") ||
            NodePath.isAbsolute(pathFromHome),
          destination,
        ).toBe(true);
      }
    }
  }
});

it("phase 3 accepts the four channel subcommands and rejects stable and unknown channel arguments", async () => {
  const { parseChannelArgs } = await import("./channel.ts");

  expect(parseChannelArgs(["build", "--channel", "dev", "--rev", revision])).toMatchObject({
    command: "build",
    channel: "dev",
    revision,
  });
  expect(parseChannelArgs(["stage", "--channel", "lab"])).toMatchObject({
    command: "stage",
    channel: "lab",
  });
  expect(parseChannelArgs(["lab", "--rev", revision])).toMatchObject({ command: "lab", revision });
  expect(parseChannelArgs(["connect"])).toMatchObject({ command: "connect" });

  for (const argv of [
    ["publish"],
    ["build", "--channel", "stable", "--rev", revision],
    ["stage", "--channel", "stable"],
    ["stage", "--channel", "nightly"],
    ["stage", "--channel"],
    ["stage"],
    ["build", "--rev", revision],
    ["build", "--channel", "dev"],
    ["lab", "--rev"],
    ["connect", "--channel", "stable"],
  ]) {
    expect(() => parseChannelArgs(argv), argv.join(" ")).toThrow();
  }
});

function writeLauncherFixture(home: string) {
  const template = NodeFS.readFileSync(new URL("./launcher.sh", import.meta.url), "utf8");
  const applications = NodePath.join(home, "Applications");
  NodeFS.mkdirSync(applications, { recursive: true });
  const launcher = NodePath.join(home, "mesura-code-lab");
  NodeFS.writeFileSync(launcher, template.replaceAll("@CHANNEL@", "lab"), { mode: 0o755 });
  const image = NodePath.join(applications, "Mesura-Code-Lab.AppImage");
  NodeFS.writeFileSync(image, '#!/bin/sh\nenv > "$HOME/app-env"\n', { mode: 0o755 });
  return { launcher, image, next: NodePath.join(applications, "Mesura-Code-Lab.next.AppImage") };
}

it("phase 3 rework: the channel launcher drops an inherited stable home and port and names itself for menu starts", () => {
  using home = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-launcher-home-"),
  );
  const { launcher } = writeLauncherFixture(home.path);
  const result = NodeChildProcess.spawnSync(launcher, [], {
    encoding: "utf8",
    env: {
      HOME: home.path,
      PATH: "/usr/bin:/bin",
      T3CODE_HOME: NodePath.join(home.path, ".mesura-code"),
      T3CODE_PORT: "3773",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const environment = NodeFS.readFileSync(NodePath.join(home.path, "app-env"), "utf8").split("\n");
  expect(environment.filter((line) => /^T3CODE_(?:HOME|PORT)=/u.test(line))).toEqual([]);
  expect(environment).toContain(`T3CODE_DESKTOP_LAUNCHER_PATH=${NodeFS.realpathSync(launcher)}`);
});

it("phase 3 rework: the channel launcher neither swaps nor starts while the channel lock is held", () => {
  using home = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-launcher-lock-"),
  );
  const { launcher, image, next } = writeLauncherFixture(home.path);
  NodeFS.writeFileSync(next, "#!/bin/sh\n", { mode: 0o755 });
  const lock = NodePath.join(home.path, ".local/state/mesura-code-lab/channel.lock");
  NodeFS.mkdirSync(NodePath.dirname(lock), { recursive: true });
  const result = NodeChildProcess.spawnSync(
    "sh",
    ["-c", 'exec 9>"$1"; flock 9; "$2"; echo "launcher exited $?"', "holder", lock, launcher],
    {
      encoding: "utf8",
      env: { HOME: home.path, PATH: "/usr/bin:/bin", MESURA_CHANNEL_LOCK_WAIT_SECONDS: "0" },
    },
  );
  expect(result.stdout).toBe("launcher exited 75\n");
  expect(NodeFS.existsSync(next)).toBe(true);
  expect(NodeFS.existsSync(`${image}.prev`)).toBe(false);
  expect(NodeFS.existsSync(NodePath.join(home.path, "app-env"))).toBe(false);
});

it("phase 3 rework: the Lab quit picks only the main process of this exact image and refuses another Lab", async () => {
  const { selectLabMainProcess } = await import("./lab-reset.ts");
  const installed = "/home/user/Applications/Mesura-Code-Lab.AppImage";
  const exe = "/tmp/.mount_MesuraA/mesura-code-channel-lab";
  const base = { uid: 1000, runsAsNode: false, startTime: "1", appImage: installed, exe };
  const target = { appImage: installed, executableName: "mesura-code-channel-lab", uid: 1000 };
  const processes = [
    { ...base, pid: 10, ppid: 1, exe: "/usr/bin/sh", appImage: undefined },
    { ...base, pid: 11, ppid: 10 },
    { ...base, pid: 12, ppid: 11 },
    { ...base, pid: 13, ppid: 11, runsAsNode: true },
    { ...base, pid: 14, ppid: 10, runsAsNode: true },
    { ...base, pid: 15, ppid: 10, uid: 1001 },
  ];
  expect(selectLabMainProcess(processes, target)?.pid).toBe(11);
  expect(selectLabMainProcess(processes.slice(0, 1), target)).toBeUndefined();
  const scratchLab = {
    ...base,
    pid: 20,
    ppid: 10,
    appImage: "/tmp/scratch/Applications/Mesura-Code-Lab.AppImage",
    exe: "/tmp/.mount_MesuraB/mesura-code-channel-lab",
  };
  expect(() => selectLabMainProcess([...processes, scratchLab], target)).toThrow(/Another Lab/u);
});

it("phase 3 rework: a retried Lab reset resumes from the backup of the interrupted one", async () => {
  const { chooseResetBackup } = await import("./lab-reset.ts");
  const destination = "/state/statev2-before-reset-2.sqlite";
  expect(
    chooseResetBackup({
      pendingBackup: "/state/statev2-before-reset-1.sqlite",
      pendingBackupExists: true,
      sourceExists: true,
      destination,
    }),
  ).toEqual({ backup: "/state/statev2-before-reset-1.sqlite", create: false });
  expect(
    chooseResetBackup({
      pendingBackup: undefined,
      pendingBackupExists: false,
      sourceExists: true,
      destination,
    }),
  ).toEqual({ backup: destination, create: true });
  expect(
    chooseResetBackup({
      pendingBackup: undefined,
      pendingBackupExists: false,
      sourceExists: false,
      destination,
    }),
  ).toBeUndefined();
});

it("phase 3 rework: pairing tokens never reach error text and supplied links come from private input", async () => {
  const { redactSecrets } = await import("./shell.ts");
  const { formatPairingUrl, parseSuppliedPairingUrls, readPrivateInput } =
    await import("./connect.ts");
  const link = formatPairingUrl({ origin: "http://127.0.0.1:3783" }, "SECRET123", "desktop");
  const phone = formatPairingUrl({ origin: "https://laptop:8783" }, "SECRET456", "phone");
  expect(
    redactSecrets(`failed: ${link} ${phone} {"credential": "x", "token": "SECRET789"}`),
  ).not.toMatch(/SECRET/u);
  expect(() =>
    parseSuppliedPairingUrls("stable=https://x/pair#token=SECRET\nnightly=SECRET"),
  ).toThrow(/^Pairing links line 2 is not/u);
  try {
    parseSuppliedPairingUrls("nightly=https://x/pair#token=SECRET");
  } catch (error) {
    expect(String(error)).not.toMatch(/SECRET/u);
  }
  expect(
    parseSuppliedPairingUrls(
      "# links\nvigilia=https://v/pair#token=A\nvigilia=https://v/pair#token=B\n",
    ),
  ).toEqual(new Map([["vigilia", ["https://v/pair#token=A", "https://v/pair#token=B"]]]));

  using scratch = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-links-"));
  const file = NodePath.join(scratch.path, "links");
  NodeFS.writeFileSync(file, "stable=https://s/pair#token=A\n", { mode: 0o644 });
  expect(() => readPrivateInput(file)).toThrow(/mode 0600/u);
  NodeFS.chmodSync(file, 0o600);
  expect(readPrivateInput(file)).toBe("stable=https://s/pair#token=A\n");
});

it("phase 3 rework: connect keeps a stopped stable app's pairings pending instead of starting it", async () => {
  const { planConnect } = await import("./connect.ts");
  const plan = planConnect({
    ...connectInput,
    unavailableClients: new Map([["stable", "the stable app is not running"]]),
  });
  expect(plan.desktopPairings.filter(({ client }) => client === "stable")).toEqual([]);
  expect(plan.desktopPairings).toHaveLength(5);
  expect(
    plan.pendingPairings.map(({ pairing, reason }) => [pairing.client, pairing.server, reason]),
  ).toEqual([
    ["stable", "lab", "the stable app is not running"],
    ["stable", "vigilia", "the stable app is not running"],
  ]);
  expect(plan.writePaths).not.toContain(stableLauncher);
});

it("phase 3 rework: a phone link is offered only for a Tailscale route that reaches that channel's backend", async () => {
  const { findServeRoutes } = await import("./connect.ts");
  const status = JSON.stringify({
    Web: {
      "laptop.example.ts.net:8783": { Handlers: { "/": { Proxy: "http://127.0.0.1:3783" } } },
      "laptop.example.ts.net:8793": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
    },
  });
  expect(findServeRoutes("laptop.example.ts.net", status, 3783)).toEqual([
    "laptop.example.ts.net:8783",
  ]);
  expect(findServeRoutes("laptop.example.ts.net", status, 3793)).toEqual([]);
  expect(findServeRoutes("laptop.example.ts.net", "{}", 3783)).toEqual([]);
});

it("phase 3 rework: a launch that began before the reset keeps the channel lock until the app is visible to the reset's scan", () => {
  using home = NodeFS.mkdtempDisposableSync(
    NodePath.join(NodeOS.tmpdir(), "mesura-launcher-race-"),
  );
  const { launcher, image } = writeLauncherFixture(home.path);
  for (const fifo of ["ready", "gate", "gate2"]) {
    NodeChildProcess.execFileSync("mkfifo", [NodePath.join(home.path, fifo)]);
  }
  // A slow AppImage start: the runtime has not yet exec'd the app with APPIMAGE set.
  NodeFS.writeFileSync(
    image,
    [
      "#!/bin/sh",
      'echo started > "$HOME/ready"',
      'read go < "$HOME/gate"',
      'exec env APPIMAGE=/fixture/Mesura-Code-Lab.AppImage cat "$HOME/gate2"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const lock = NodePath.join(home.path, ".local/state/mesura-code-lab/channel.lock");
  const result = NodeChildProcess.spawnSync(
    "sh",
    [
      "-c",
      [
        '"$1" & launched=$!',
        'read line < "$HOME/ready"',
        'flock -n "$2" true; echo "while starting: $?"',
        'echo go > "$HOME/gate"',
        'flock -w 30 "$2" true; echo "once visible: $?"',
        'echo done > "$HOME/gate2"',
        'wait "$launched"',
      ].join("\n"),
      "reset",
      launcher,
      lock,
    ],
    { encoding: "utf8", env: { HOME: home.path, PATH: "/usr/bin:/bin" } },
  );
  expect(result.stdout, result.stderr).toBe("while starting: 1\nonce visible: 0\n");
});

it("phase 3 rework: a pairing URL pasted as the links file path is not echoed back", async () => {
  const { readPrivateInput } = await import("./connect.ts");
  expect(() => readPrivateInput("https://laptop:3773/pair#token=PASTED123")).toThrow(
    /^Could not read the file given to --pairing-urls \(ENOENT\)\.$/u,
  );
});

it("phase 3 rework: connect re-checks the stable app in the same step and skips the hand-off when it stopped", async () => {
  const { handoffScript } = await import("./connect.ts");
  const result = NodeChildProcess.spawnSync(
    "sh",
    ["-c", `set -eu\n${handoffScript("true", "http://127.0.0.1:9/.well-known/t3/environment")}`],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );
  expect([result.status, result.stdout]).toEqual([0, "not-running\n"]);
});

it("phase 3 regression: a failed build leaves the last verified artifact and its record, and the next success prunes only stale runs", async () => {
  const { planBuild, publishArtifact } = await import("./build.ts");
  const first = planBuild({ channel: "lab", revision, deployHome, runId: "r1" });
  const second = planBuild({ channel: "lab", revision, deployHome, runId: "r2" });
  const firstPackage = first.steps.find((step) => step.kind === "package");
  const secondPackage = second.steps.find((step) => step.kind === "package");
  expect(first.outputRoot).toBe(second.outputRoot);
  expect(firstPackage?.kind === "package" && firstPackage.outputDir).toBe(
    NodePath.join(first.outputRoot, "r1"),
  );
  expect(secondPackage?.kind === "package" && secondPackage.outputDir).toBe(
    NodePath.join(first.outputRoot, "r2"),
  );

  using scratch = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-publish-"));
  const outputRoot = NodePath.join(scratch.path, "builds");
  const record = NodePath.join(scratch.path, "state", "lab-latest.json");
  const artifactIn = (run: string) => {
    const path = NodePath.join(outputRoot, run, "Mesura-Code-Lab.AppImage");
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, run);
    return {
      channel: "lab" as const,
      revision,
      commit: run,
      path,
      sha256: run,
      electron: "44.10.1",
      runId: run,
    };
  };
  const recorded = () => JSON.parse(NodeFS.readFileSync(record, "utf8")).runId;

  publishArtifact(outputRoot, record, artifactIn("r1"));
  // A failed run leaves a partial directory and never publishes.
  NodeFS.mkdirSync(NodePath.join(outputRoot, "r2"));
  NodeFS.writeFileSync(NodePath.join(outputRoot, "r2", "partial"), "");
  expect(recorded()).toBe("r1");
  expect(
    NodeFS.readFileSync(NodePath.join(outputRoot, "r1", "Mesura-Code-Lab.AppImage"), "utf8"),
  ).toBe("r1");

  publishArtifact(outputRoot, record, artifactIn("r3"));
  expect(recorded()).toBe("r3");
  expect(NodeFS.readdirSync(outputRoot).sort()).toEqual(["r1", "r3"]);
  expect(NodeFS.existsSync(`${record}.tmp`)).toBe(false);

  publishArtifact(outputRoot, record, artifactIn("r4"));
  expect(NodeFS.readdirSync(outputRoot).sort()).toEqual(["r3", "r4"]);
});

it("phase 3 regression: the deploy worktree's pnpm-lock.yaml is restored when the install fails", async () => {
  const { installWithLockfileRestored } = await import("./build.ts");
  using repository = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-lock-"));
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", repository.path, ...args], { encoding: "utf8" });
  git("init", "-q");
  const lockfile = NodePath.join(repository.path, "pnpm-lock.yaml");
  NodeFS.writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
  git("add", "pnpm-lock.yaml");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-q",
    "-m",
    "lock",
  );

  expect(() =>
    installWithLockfileRestored(repository.path, () => {
      NodeFS.appendFileSync(lockfile, "  '@pnpm/exe': host artifact\n");
      throw new Error("pnpm install failed");
    }),
  ).toThrow("pnpm install failed");
  expect(NodeFS.readFileSync(lockfile, "utf8")).toBe("lockfileVersion: '9.0'\n");
});

it("phase 3 regression: the in-workload build executor refuses outside its unit or without the lock marker", async () => {
  const { assertInBuildWorkload, BUILD_LOCK_HELD_ENV } = await import("./build.ts");
  const plan = { workloadName: "mesura-channel-build" };
  const insideUnit =
    "0::/user.slice/mesura-agents.slice/mesura-workload-mesura-channel-build.service\n";
  const agentScope = "0::/user.slice/mesura-agents.slice/session-1.scope\n";
  const locked = { [BUILD_LOCK_HELD_ENV]: "run-1" };

  expect(() =>
    assertInBuildWorkload(plan, "run-1", { env: locked, cgroup: insideUnit }),
  ).not.toThrow();
  for (const context of [
    { env: {}, cgroup: insideUnit },
    { env: { [BUILD_LOCK_HELD_ENV]: "run-0" }, cgroup: insideUnit },
    { env: locked, cgroup: agentScope },
  ]) {
    expect(() => assertInBuildWorkload(plan, "run-1", context)).toThrow(/--in-workload/u);
  }
});

it("phase 3 regression: connect's preflight leaves pairings pending for a stopped stable app and a missing launcher or image", async () => {
  const { parsePreflight, planConnect, preflightScript } = await import("./connect.ts");
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-preflight-"));
  const bin = NodePath.join(home.path, ".local/bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  for (const launcher of ["mesura-sync-test", "mesura-code-lab"]) {
    NodeFS.writeFileSync(NodePath.join(bin, launcher), "#!/bin/sh\n", { mode: 0o755 });
  }
  const unreachable = "http://127.0.0.1:9/.well-known/t3/environment";
  const run = () =>
    NodeChildProcess.execFileSync(
      "sh",
      ["-c", `set -eu\n${preflightScript(home.path, unreachable)}`],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );

  const unavailable = parsePreflight(run());
  expect([...unavailable.keys()].sort()).toEqual(["dev", "lab", "stable"]);
  expect(unavailable.get("stable")).toMatch(/not running/u);
  expect(unavailable.get("dev")).toMatch(/no launcher/u);
  expect(unavailable.get("lab")).toMatch(/no lab AppImage/u);
  const plan = planConnect({
    ...connectInput,
    laptopHome: home.path,
    unavailableClients: unavailable,
  });
  expect(plan.desktopPairings).toEqual([]);
  expect(plan.pendingPairings).toHaveLength(7);

  NodeFS.writeFileSync(NodePath.join(bin, "mesura-code-dev"), "#!/bin/sh\n", { mode: 0o755 });
  const applications = NodePath.join(home.path, "Applications");
  NodeFS.mkdirSync(applications);
  NodeFS.writeFileSync(NodePath.join(applications, "Mesura-Code-Dev.AppImage"), "");
  NodeFS.writeFileSync(NodePath.join(applications, "Mesura-Code-Lab.next.AppImage"), "");
  expect([...parsePreflight(run()).keys()]).toEqual(["stable"]);
});

it("phase 3 regression: the readiness wait is one wall-clock deadline, so a spent budget fails at once", async () => {
  const { readinessWaitScript } = await import("./shell.ts");
  const result = NodeChildProcess.spawnSync(
    "sh",
    ["-c", `set -eu\n${readinessWaitScript("http://127.0.0.1:9/.well-known/t3/environment", 0)}`],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/did not answer in time/u);
});

function followDevArtifact(home: string, commit: string): BuildArtifact {
  const path = NodePath.join(home, commit, "Mesura-Code-Dev.AppImage");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, commit);
  return {
    channel: "dev",
    revision: commit,
    commit,
    path,
    sha256: "d".repeat(64),
    electron: "44.10.1",
    runId: commit,
  };
}

async function followDevFixture(home: string, initialSha: string) {
  const { runFollowDevTick } = await import("./follow-dev.ts");
  const fetchOriginDev = vi.fn(async () => initialSha);
  const build = vi.fn(async ({ revision }: BuildInput) => followDevArtifact(home, revision));
  const isLaptopReachable = vi.fn(async () => true);
  const stage = vi.fn(async (artifact: BuildArtifact) => {
    expect(NodeFS.readFileSync(artifact.path, "utf8")).toBe(artifact.commit);
  });
  return {
    fetchOriginDev,
    build,
    isLaptopReachable,
    stage,
    tick: () =>
      runFollowDevTick({ deployHome: home, fetchOriginDev, build, isLaptopReachable, stage }),
  };
}

function readFollowDevRecord(home: string) {
  const directory = NodePath.join(home, ".local/state/mesura-channel");
  for (const name of NodeFS.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
    ) as Record<string, unknown>;
    if ("lastBuiltSha" in record) return record;
  }
  throw new Error(`No follow-dev state record in ${directory}.`);
}

const firstDevSha = "a".repeat(40);
const nextDevSha = "b".repeat(40);

it("phase 4 follow-dev fetches on every tick and builds the fetched Dev revision only when the recorded SHA changes", async () => {
  const { parseChannelArgs } = await import("./channel.ts");
  expect(parseChannelArgs(["follow-dev"])).toMatchObject({ command: "follow-dev" });

  const { decideFollowDevTick } = await import("./follow-dev.ts");
  const state = { lastBuiltSha: firstDevSha, lastStagedSha: firstDevSha };
  expect(decideFollowDevTick(state, { originDevSha: firstDevSha })).toMatchObject({ kind: "idle" });
  expect(decideFollowDevTick(state, { originDevSha: nextDevSha })).toMatchObject({
    kind: "build",
    sha: nextDevSha,
  });

  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const first = await followDevFixture(home.path, firstDevSha);
  await first.tick();
  // Once before deciding and once after the build, since dev can move while it packages.
  expect(first.fetchOriginDev).toHaveBeenCalledTimes(2);
  expect(first.build).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ channel: "dev", revision: firstDevSha }),
  );
  expect(readFollowDevRecord(home.path)).toMatchObject({ lastBuiltSha: firstDevSha });

  const next = await followDevFixture(home.path, firstDevSha);
  await next.tick();
  expect(next.fetchOriginDev).toHaveBeenCalledTimes(1);
  expect(next.build).not.toHaveBeenCalled();
  next.fetchOriginDev.mockResolvedValue(nextDevSha);
  await next.tick();
  expect(next.fetchOriginDev).toHaveBeenCalledTimes(3);
  expect(next.build).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ channel: "dev", revision: nextDevSha }),
  );
  expect(readFollowDevRecord(home.path)).toMatchObject({ lastBuiltSha: nextDevSha });
});

it("phase 4 follow-dev records a failed build and its log and retries the same Dev SHA", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const fixture = await followDevFixture(home.path, firstDevSha);
  await fixture.tick();

  const logPath = NodePath.join(home.path, ".local/state/mesura-channel/dev-build.log");
  const failure = "Fixture packaging failed";
  fixture.fetchOriginDev.mockResolvedValue(nextDevSha);
  fixture.build.mockRejectedValueOnce(new Error(failure));
  await fixture.tick().catch((error: unknown) => expect(String(error)).toContain(failure));

  const record = readFollowDevRecord(home.path);
  expect(record).toMatchObject({ lastBuiltSha: firstDevSha, lastStagedSha: firstDevSha });
  expect(JSON.stringify(record.lastError)).toContain(failure);
  expect(JSON.stringify(record.lastError)).toContain(logPath);
  expect(fixture.stage).toHaveBeenCalledTimes(1);

  await fixture.tick();
  expect(fixture.build.mock.calls.map(([input]) => input.revision)).toEqual([
    firstDevSha,
    nextDevSha,
    nextDevSha,
  ]);
  expect(readFollowDevRecord(home.path)).toMatchObject({ lastBuiltSha: nextDevSha });
});

it("phase 4 follow-dev keeps the Dev AppImage while the laptop is offline and stages it without rebuilding", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const offline = await followDevFixture(home.path, firstDevSha);
  offline.isLaptopReachable.mockResolvedValue(false);
  await offline.tick();

  const appImage = NodePath.join(home.path, firstDevSha, "Mesura-Code-Dev.AppImage");
  const offlineRecord = readFollowDevRecord(home.path);
  expect(offline.isLaptopReachable).toHaveBeenCalledOnce();
  expect(offline.stage).not.toHaveBeenCalled();
  expect(offlineRecord.lastBuiltSha).toBe(firstDevSha);
  expect(offlineRecord.lastStagedSha).not.toBe(firstDevSha);
  expect(JSON.stringify(offlineRecord.pendingAppImage)).toContain(appImage);
  expect(NodeFS.readFileSync(appImage, "utf8")).toBe(firstDevSha);

  const online = await followDevFixture(home.path, firstDevSha);
  await online.tick();
  expect(online.build).not.toHaveBeenCalled();
  expect(online.stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ commit: firstDevSha, path: appImage }),
  );
  expect(readFollowDevRecord(home.path)).toMatchObject({ lastStagedSha: firstDevSha });
});

it("phase 4 follow-dev stages only the newest Dev SHA when a newer merge replaces a pending build", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const fixture = await followDevFixture(home.path, firstDevSha);
  fixture.isLaptopReachable.mockResolvedValueOnce(false);
  await fixture.tick();
  expect(fixture.stage).not.toHaveBeenCalled();

  fixture.fetchOriginDev.mockResolvedValue(nextDevSha);
  await fixture.tick();

  expect(fixture.build.mock.calls.map(([input]) => input.revision)).toEqual([
    firstDevSha,
    nextDevSha,
  ]);
  expect(fixture.stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      commit: nextDevSha,
      path: NodePath.join(home.path, nextDevSha, "Mesura-Code-Dev.AppImage"),
    }),
  );
  expect(readFollowDevRecord(home.path)).toMatchObject({
    lastBuiltSha: nextDevSha,
    lastStagedSha: nextDevSha,
  });
});

it("phase 4 follow-dev ships a persistent quarter-hour timer, a memory-limited service, and installation and removal commands", () => {
  const timer = NodeFS.readFileSync(
    new URL("./systemd/mesura-channel-dev.timer", import.meta.url),
    "utf8",
  );
  const service = NodeFS.readFileSync(
    new URL("./systemd/mesura-channel-dev.service", import.meta.url),
    "utf8",
  );
  const docs = NodeFS.readFileSync(
    new URL("../../docs/operations/mesura-channels.md", import.meta.url),
    "utf8",
  );

  // Persistent= catches up only for OnCalendar= timers, so a monotonic schedule does not qualify.
  expect(timer).toMatch(/^OnCalendar=.*[ *]:(?:00?\/15|00?,15,30,45)(?::00)?$/mu);
  expect(timer).not.toMatch(/^On(?:Unit|Boot|Startup|Active)\w*Sec=/mu);
  expect(timer).toMatch(/^Persistent=true$/mu);
  expect(service).toMatch(/^WorkingDirectory=\/opt\/dev\/deploy\/mesura-channel-follower$/mu);
  expect(service).toMatch(/^Slice=(?!app\.slice$)[\w.-]+\.slice$/mu);
  expect(service).toMatch(/^MemoryMax=[1-9]\d*[KMGT]?$/mu);
  expect(service).toMatch(
    /^ExecStart=.*\bnode\b[^\n]*scripts\/mesura-channel\/channel\.ts\s+follow-dev\b/mu,
  );
  expect(docs).toContain("mesura-channel-dev.service");
  expect(docs).toMatch(/systemctl --user enable[^\n]*mesura-channel-dev\.timer/u);
  expect(docs).toMatch(/systemctl --user disable[^\n]*mesura-channel-dev\.timer/u);
});

it("phase 4 rework: a merge that lands during a Dev build is built in the same tick and only it is staged", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const fixture = await followDevFixture(home.path, firstDevSha);
  fixture.build.mockImplementationOnce(async ({ revision }: BuildInput) => {
    fixture.fetchOriginDev.mockResolvedValue(nextDevSha);
    return followDevArtifact(home.path, revision);
  });
  await fixture.tick();

  expect(fixture.build.mock.calls.map(([input]) => input.revision)).toEqual([
    firstDevSha,
    nextDevSha,
  ]);
  expect(fixture.stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ commit: nextDevSha }),
  );
  expect(readFollowDevRecord(home.path)).toMatchObject({
    lastBuiltSha: nextDevSha,
    lastStagedSha: nextDevSha,
    pendingAppImage: null,
  });
});

it("phase 4 rework: a follow-dev tick skips while another tick holds the follower lock", async () => {
  const { tryHoldFileLock } = await import("./shell.ts");
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const fixture = await followDevFixture(home.path, firstDevSha);
  {
    using held = tryHoldFileLock(
      NodePath.join(home.path, ".local/state/mesura-channel/dev-follow.lock"),
    );
    expect(held).toBeDefined();
    await fixture.tick();
    expect(fixture.fetchOriginDev).not.toHaveBeenCalled();
    expect(fixture.build).not.toHaveBeenCalled();
    expect(
      NodeFS.existsSync(NodePath.join(home.path, ".local/state/mesura-channel/dev-follow.json")),
    ).toBe(false);
  }
  await fixture.tick();
  expect(fixture.build).toHaveBeenCalledOnce();
  expect(readFollowDevRecord(home.path)).toMatchObject({ lastStagedSha: firstDevSha });
});

it("phase 4 rework: build cleanup keeps the follower's unstaged Dev build through later manual builds", async () => {
  const { planBuild, publishBuildArtifact } = await import("./build.ts");
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const plan = planBuild({ channel: "dev", revision: "dev", deployHome: home.path });
  const record = NodePath.join(home.path, ".local/state/mesura-channel/dev-latest.json");
  const publish = (runId: string) =>
    publishBuildArtifact(plan, record, followDevArtifact(plan.outputRoot, runId));
  const pending = followDevArtifact(plan.outputRoot, "r1");
  publishBuildArtifact(plan, record, pending);
  NodeFS.writeFileSync(
    plan.followRecord,
    JSON.stringify({ lastBuiltSha: "r1", lastStagedSha: null, pendingAppImage: pending }),
  );

  publish("r2");
  publish("r3");
  expect(NodeFS.readdirSync(plan.outputRoot).sort()).toEqual(["r1", "r2", "r3"]);
  publish("r4");
  expect(NodeFS.readdirSync(plan.outputRoot).sort()).toEqual(["r1", "r3", "r4"]);
  expect(NodeFS.readFileSync(pending.path, "utf8")).toBe("r1");
});

/** Fake `git`, `ssh` and `rsync` on PATH; the fake laptop runs remote scripts locally in a scratch home. */
function fakeLaptopCommands(root: string) {
  const home = NodePath.join(root, "vigilia");
  const laptop = NodePath.join(root, "laptop");
  const bin = NodePath.join(root, "bin");
  const calls = NodePath.join(root, "calls.log");
  const failRemote = NodePath.join(root, "fail-remote");
  NodeFS.mkdirSync(bin);
  NodeFS.mkdirSync(laptop);
  const fake = (name: string, body: string) =>
    NodeFS.writeFileSync(
      NodePath.join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${calls}'\n${body}\n`,
      { mode: 0o755 },
    );
  fake("git", `case "$*" in *rev-parse*) echo ${firstDevSha} ;; esac`);
  fake(
    "ssh",
    `while [ "$1" = -o ]; do shift 2; done; shift
[ "$*" = true ] && exit 0
[ -e '${failRemote}' ] && exit 1
exec sh -s`,
  );
  fake(
    "rsync",
    `for last; do :; done
eval "src=\\\${$(($# - 1))}"
cp "$src" "\${last#*:}"`,
  );
  return {
    home,
    laptop,
    calls,
    failRemote,
    async withFakeCommands<T>(body: () => Promise<T>): Promise<T> {
      vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
      vi.stubEnv("MESURA_CHANNEL_LAPTOP_TARGET", "fixture@laptop");
      vi.stubEnv("MESURA_CHANNEL_LAPTOP_HOME", laptop);
      try {
        return await body();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  };
}

it("phase 4 rework: follow-dev's production fetch, probe and stage adapters send the right ref and file and advance the record only on success", async () => {
  const { runFollowDevTick } = await import("./follow-dev.ts");
  const { planStage } = await import("./stage.ts");
  const { sha256File } = await import("./shell.ts");
  using scratch = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-io-"));
  const { home, laptop, calls, failRemote, withFakeCommands } = fakeLaptopCommands(scratch.path);
  const artifact = followDevArtifact(NodePath.join(scratch.path, "builds"), firstDevSha);
  const builtArtifact = { ...artifact, sha256: sha256File(artifact.path) };
  const build = vi.fn(async () => builtArtifact);
  const record = () => readFollowDevRecord(home);

  await withFakeCommands(async () => {
    NodeFS.writeFileSync(failRemote, "");
    await expect(runFollowDevTick({ deployHome: home, build })).rejects.toThrow();
    expect(record()).toMatchObject({ lastBuiltSha: firstDevSha, lastStagedSha: null });
    expect(record().lastError).toMatchObject({ step: "stage", sha: firstDevSha });

    NodeFS.rmSync(failRemote);
    await runFollowDevTick({ deployHome: home, build });
  });

  const log = NodeFS.readFileSync(calls, "utf8");
  expect(log).toContain("git -C /opt/dev/repos/mesura-code fetch -q origin dev\n");
  expect(log).toContain(
    "git -C /opt/dev/repos/mesura-code rev-parse --verify -q origin/dev^{commit}\n",
  );
  expect(log).toContain(
    "ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 fixture@laptop true\n",
  );
  const next = NodePath.join(laptop, "Applications/Mesura-Code-Dev.next.AppImage");
  expect(log).toMatch(
    new RegExp(
      `rsync -t --partial ${artifact.path} fixture@laptop:${next}\\.incoming-[0-9a-f]+\\n`,
      "u",
    ),
  );
  expect(build).toHaveBeenCalledOnce();
  expect(NodeFS.readFileSync(next, "utf8")).toBe(firstDevSha);
  expect(NodeFS.readdirSync(NodePath.dirname(next))).toEqual(["Mesura-Code-Dev.next.AppImage"]);
  expect(record()).toMatchObject({ lastStagedSha: firstDevSha, lastError: null });

  const stageInputFor = { ...stageInput, channel: "dev" as const };
  expect(planStage(stageInputFor).appImage.incoming).not.toBe(
    planStage(stageInputFor).appImage.incoming,
  );
});

it("phase 4 regression: a tick builds at most three Dev SHAs while dev keeps moving and leaves the newest for the next tick unstaged", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const shas = ["1", "2", "3", "4", "5"].map((digit) => digit.repeat(40));
  const fixture = await followDevFixture(home.path, shas[0] ?? "");
  let moves = 0;
  fixture.build.mockImplementation(async ({ revision }: BuildInput) => {
    moves += 1;
    fixture.fetchOriginDev.mockResolvedValue(shas[moves] ?? "");
    return followDevArtifact(home.path, revision);
  });
  await fixture.tick();

  expect(fixture.build.mock.calls.map(([input]) => input.revision)).toEqual(shas.slice(0, 3));
  expect(fixture.stage).not.toHaveBeenCalled();
  const record = readFollowDevRecord(home.path);
  expect(record).toMatchObject({ lastBuiltSha: shas[2], lastStagedSha: null, lastError: null });
  expect(JSON.stringify(record.pendingAppImage)).toContain(shas[2]);

  fixture.build.mockImplementation(async ({ revision }: BuildInput) =>
    followDevArtifact(home.path, revision),
  );
  await fixture.tick();
  expect(fixture.build.mock.calls.map(([input]) => input.revision)).toEqual(shas.slice(0, 4));
  expect(fixture.stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ commit: shas[3] }),
  );
});

it("phase 4 regression: follow-dev refuses an origin/dev value that is not a commit SHA before building", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  for (const value of ["", "dev", "a".repeat(39), "A".repeat(40)]) {
    const fixture = await followDevFixture(home.path, value);
    await expect(fixture.tick()).rejects.toThrow(/not a commit SHA/u);
    expect(fixture.build).not.toHaveBeenCalled();
  }
  const sha256Fixture = await followDevFixture(home.path, "c".repeat(64));
  await sha256Fixture.tick();
  expect(sha256Fixture.build).toHaveBeenCalledOnce();
});

it("phase 4 regression: follow-dev builds the recorded SHA again when its unstaged AppImage was removed", async () => {
  using home = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-dev-"));
  const offline = await followDevFixture(home.path, firstDevSha);
  offline.isLaptopReachable.mockResolvedValue(false);
  await offline.tick();
  NodeFS.rmSync(NodePath.join(home.path, firstDevSha), { recursive: true });

  const online = await followDevFixture(home.path, firstDevSha);
  await online.tick();
  expect(online.build).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ revision: firstDevSha }),
  );
  expect(online.stage).toHaveBeenCalledOnce();
  expect(readFollowDevRecord(home.path)).toMatchObject({ lastStagedSha: firstDevSha });
});

it("phase 4 regression: a copy that fails the locked hash check is removed and nothing is staged", async () => {
  const { executeStage, planStage } = await import("./stage.ts");
  using scratch = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "mesura-follow-io-"));
  const { laptop, withFakeCommands } = fakeLaptopCommands(scratch.path);
  const artifact = followDevArtifact(NodePath.join(scratch.path, "builds"), firstDevSha);
  const plan = planStage({
    channel: "dev",
    appImagePath: artifact.path,
    sha256: "0".repeat(64),
    laptopHome: laptop,
    laptopTarget: "fixture@laptop",
  });

  await withFakeCommands(async () => {
    expect(() => executeStage(plan)).toThrow(/hashes to/u);
  });
  expect(NodeFS.readdirSync(NodePath.join(laptop, "Applications"))).toEqual([]);
  expect(NodeFS.existsSync(plan.launcher.destination)).toBe(false);
});
