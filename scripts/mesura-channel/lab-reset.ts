// @effect-diagnostics nodeBuiltinImport:off - Wipes Lab on the laptop; runs there inside the Lab AppImage's Node.
/**
 * Puts a new branch in Lab. The build host builds and stages it, then sends the laptop half of the
 * plan to `runLabResetOnLaptop`, bundled into one file and run with the staged AppImage's own Node
 * (`ELECTRON_RUN_AS_NODE=1`), because the laptop has no build checkout.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { laptopChannelPaths, READINESS_WAIT_SECONDS } from "./config.ts";
import {
  bundledCliScript,
  hyprlandExecScript,
  readinessWaitScript,
  sha256File,
  shellCommand,
  shellQuote,
} from "./shell.ts";

/**
 * Sign-in rows other clients hold for Lab. Without them every client loses its Lab sign-in
 * (`SessionStore.ts` checks `auth_sessions`). `apps/server/scripts/migrate-dev-db.ts` clears the
 * same tables from the other side.
 */
export const LAB_AUTH_TABLES = [
  "auth_sessions",
  "auth_pairing_links",
  "mesura_mcp_refresh_tokens",
  "peer_environment_links",
] as const;

const LAB_BACKUP_PREFIX = "statev2-before-reset-";

/** A leftover `state.sqlite` would be re-imported into the fresh `statev2.sqlite`. */
const LAB_DATABASE_FILES = new Set(
  ["state.sqlite", "statev2.sqlite"].flatMap((name) =>
    ["", "-journal", "-wal", "-shm"].map((suffix) => `${name}${suffix}`),
  ),
);

export function labDatabasePaths(stateDirectory: string, entries: Iterable<string>) {
  return [...entries]
    .filter((entry) => LAB_DATABASE_FILES.has(entry))
    .map((entry) => NodePath.join(stateDirectory, entry))
    .sort();
}

export interface LabResetInput {
  readonly revision: string;
  readonly laptopHome: string;
  readonly laptopTarget: string;
  /** Names in Lab's state directory when the plan was made; the laptop lists it again before deleting. */
  readonly stateEntries?: ReadonlyArray<string>;
  /** Names this reset's backup; the build host passes a timestamp. */
  readonly resetId?: string;
  /** The staged image's verified hash; the laptop checks it before migrating with that image. */
  readonly sha256?: string;
}

export type LabLaptopStep =
  | {
      readonly kind: "quit";
      readonly target: string;
      readonly appImage: string;
      readonly executableName: string;
      readonly processLookup: "fuse-mount";
    }
  | {
      readonly kind: "backup-db";
      readonly source: string;
      readonly destination: string;
      /** Names the backup of a reset that has not relaunched yet; a retry resumes from it. */
      readonly pendingMarker: string;
    }
  | { readonly kind: "remove-worktrees"; readonly directory: string }
  | {
      readonly kind: "delete-databases";
      readonly stateDirectory: string;
      readonly paths: ReadonlyArray<string>;
    }
  | {
      readonly kind: "migrate-db";
      readonly baseDir: string;
      readonly appImage: string;
      readonly sha256: string | null;
    }
  | { readonly kind: "restore-auth"; readonly destination: string; readonly pendingMarker: string }
  | {
      readonly kind: "relaunch";
      readonly executable: string;
      readonly laptopHome: string;
      readonly readinessUrl: string;
      readonly pendingMarker: string;
    };

export type LabResetStep =
  | { readonly kind: "build"; readonly channel: "lab"; readonly revision: string }
  | { readonly kind: "stage"; readonly channel: "lab"; readonly target: string }
  | LabLaptopStep;

export function planLabReset(input: LabResetInput) {
  const lab = laptopChannelPaths(input.laptopHome, "lab");
  const database = NodePath.join(lab.stateDirectory, "statev2.sqlite");
  const backup = NodePath.join(
    lab.toolState,
    `${LAB_BACKUP_PREFIX}${input.resetId ?? "manual"}.sqlite`,
  );
  const pendingMarker = NodePath.join(lab.toolState, "reset-pending.json");
  const databasePaths = labDatabasePaths(lab.stateDirectory, input.stateEntries ?? []);
  const steps: ReadonlyArray<LabResetStep> = [
    { kind: "build", channel: "lab", revision: input.revision },
    { kind: "stage", channel: "lab", target: input.laptopTarget },
    {
      kind: "quit",
      target: input.laptopTarget,
      appImage: lab.appImage,
      executableName: lab.executableName,
      processLookup: "fuse-mount",
    },
    { kind: "backup-db", source: database, destination: backup, pendingMarker },
    { kind: "remove-worktrees", directory: lab.worktrees },
    { kind: "delete-databases", stateDirectory: lab.stateDirectory, paths: databasePaths },
    // The CLI runs pending migrations while no server owns the home (`layerCliConfig`).
    {
      kind: "migrate-db",
      baseDir: lab.home,
      appImage: lab.nextAppImage,
      sha256: input.sha256 ?? null,
    },
    { kind: "restore-auth", destination: database, pendingMarker },
    {
      kind: "relaunch",
      executable: lab.launcher,
      laptopHome: input.laptopHome,
      readinessUrl: lab.readinessUrl,
      pendingMarker,
    },
  ];
  const laptopSteps = steps.filter(
    (step): step is LabLaptopStep => step.kind !== "build" && step.kind !== "stage",
  );
  return {
    steps,
    laptopSteps,
    /** Where the build host copies the bundled laptop half before running it. */
    laptopScript: NodePath.join(lab.toolState, "lab-reset.mjs"),
    nextAppImage: lab.nextAppImage,
    channelLock: lab.channelLock,
    writePaths: [
      backup,
      pendingMarker,
      lab.channelLock,
      NodePath.join(lab.toolState, "lab-reset.mjs"),
      NodePath.join(lab.toolState, "launch.log"),
      lab.worktrees,
      ...labDatabasePaths(lab.stateDirectory, LAB_DATABASE_FILES),
      lab.appImage,
      lab.previousAppImage,
      lab.nextAppImage,
      `${lab.nextAppImage}.incoming`,
      lab.launcher,
    ],
  };
}

export interface AuthTableCopy {
  readonly table: string;
  readonly copiedRows: number;
  /** Backup columns the fresh schema no longer has. */
  readonly droppedColumns: ReadonlyArray<string>;
  readonly skipped?: "missing-in-backup" | "missing-in-fresh";
}

function columnNames(database: NodeSqlite.DatabaseSync, schema: string, table: string) {
  return database
    .prepare(`SELECT name FROM pragma_table_info(?, ?)`)
    .all(table, schema)
    .map((row) => String(row.name));
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Copies the sign-in rows from the backup into the freshly migrated database over the columns
 * both schemas share, so a branch that changed an auth table keeps what it can.
 */
export async function copyLabAuthRows(
  sourcePath: string,
  destinationPath: string,
): Promise<ReadonlyArray<AuthTableCopy>> {
  using database = new NodeSqlite.DatabaseSync(destinationPath);
  database.prepare("ATTACH DATABASE ? AS backup").run(sourcePath);
  const report: Array<AuthTableCopy> = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of LAB_AUTH_TABLES) {
      const sourceColumns = columnNames(database, "backup", table);
      const destinationColumns = new Set(columnNames(database, "main", table));
      if (sourceColumns.length === 0 || destinationColumns.size === 0) {
        report.push({
          table,
          copiedRows: 0,
          droppedColumns: [],
          skipped: sourceColumns.length === 0 ? "missing-in-backup" : "missing-in-fresh",
        });
        continue;
      }
      const shared = sourceColumns.filter((column) => destinationColumns.has(column));
      const columns = shared.map(quoteIdentifier).join(", ");
      const result = database
        .prepare(
          `INSERT OR REPLACE INTO main.${quoteIdentifier(table)} (${columns}) SELECT ${columns} FROM backup.${quoteIdentifier(table)}`,
        )
        .run();
      report.push({
        table,
        copiedRows: Number(result.changes),
        droppedColumns: sourceColumns.filter((column) => !destinationColumns.has(column)),
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("DETACH DATABASE backup");
  }
  return report;
}

function sh(script: string): string {
  return NodeChildProcess.execFileSync("sh", ["-c", `set -eu\n${script}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function log(line: string) {
  process.stdout.write(`lab-reset: ${line}\n`);
}

export interface LabProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly exe: string;
  /** `APPIMAGE` from the process environment: the AppImage runtime sets it to the image's real path. */
  readonly appImage: string | undefined;
  readonly runsAsNode: boolean;
  readonly startTime: string;
}

/**
 * The Lab app's main process for this exact image. Renderers, the GPU process and the bundled
 * server share its executable but have it as their parent. Another Lab main process (a scratch
 * Lab, or one still running from a renamed image) makes the lookup ambiguous, so it throws.
 */
export function selectLabMainProcess(
  processes: ReadonlyArray<LabProcess>,
  target: { readonly appImage: string; readonly executableName: string; readonly uid: number },
): LabProcess | undefined {
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  const mains = processes.filter(
    (candidate) =>
      candidate.uid === target.uid &&
      !candidate.runsAsNode &&
      NodePath.basename(candidate.exe) === target.executableName &&
      byPid.get(candidate.ppid)?.exe !== candidate.exe,
  );
  const others = mains.filter((candidate) => candidate.appImage !== target.appImage);
  if (others.length > 0) {
    throw new Error(
      `Another Lab runs (pid ${others.map(({ pid }) => pid).join(", ")} from ${others[0]?.appImage ?? "an unknown image"}); quit it first. Nothing changed.`,
    );
  }
  if (mains.length > 1) {
    throw new Error(`Several Lab main processes run (${mains.map(({ pid }) => pid).join(", ")}).`);
  }
  return mains[0];
}

function readProcess(pid: number): LabProcess | undefined {
  try {
    const status = NodeFS.readFileSync(`/proc/${pid}/status`, "utf8");
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const environment = NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const variable = (name: string) =>
      environment.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
    return {
      pid,
      ppid: Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1] ?? 0),
      uid: Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1] ?? -1),
      exe: NodeFS.readlinkSync(`/proc/${pid}/exe`),
      appImage: variable("APPIMAGE"),
      runsAsNode: variable("ELECTRON_RUN_AS_NODE") === "1",
      // Field 22 after the parenthesised command name: the start time, which a reused PID changes.
      startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "",
    };
  } catch {
    return undefined;
  }
}

function listProcesses(): ReadonlyArray<LabProcess> {
  return NodeFS.readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number)
    .filter((pid) => pid !== process.pid)
    .flatMap((pid) => readProcess(pid) ?? []);
}

/** A retry after an interrupted reset keeps the backup taken before the first wipe. */
export function chooseResetBackup(input: {
  readonly pendingBackup: string | undefined;
  readonly pendingBackupExists: boolean;
  readonly sourceExists: boolean;
  readonly destination: string;
}): { readonly backup: string; readonly create: boolean } | undefined {
  if (input.pendingBackup !== undefined && input.pendingBackupExists) {
    return { backup: input.pendingBackup, create: false };
  }
  return input.sourceExists ? { backup: input.destination, create: true } : undefined;
}

function readPendingBackup(marker: string): string | undefined {
  if (!NodeFS.existsSync(marker)) return undefined;
  const backup = (JSON.parse(NodeFS.readFileSync(marker, "utf8")) as { backup?: unknown }).backup;
  return typeof backup === "string" ? backup : undefined;
}

/**
 * The laptop half: the wipe runs under the channel lock the launcher and `stage` share, so no
 * launch can open Lab or take `.next` before the sign-ins are back; the relaunch runs after it.
 */
export function labResetRemoteScript(plan: ReturnType<typeof planLabReset>): string {
  const run = (steps: ReadonlyArray<LabLaptopStep>) =>
    `ELECTRON_RUN_AS_NODE=1 ${shellCommand([plan.nextAppImage, plan.laptopScript, JSON.stringify(steps)])}`;
  return [
    `mkdir -p ${shellQuote(NodePath.dirname(plan.channelLock))}`,
    `exec 9>${shellQuote(plan.channelLock)}`,
    "flock -w 900 9",
    run(plan.laptopSteps.filter((step) => step.kind !== "relaunch")),
    "exec 9>&-",
    run(plan.laptopSteps.filter((step) => step.kind === "relaunch")),
  ].join("\n");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeWorktrees(directory: string) {
  if (!NodeFS.existsSync(directory)) return;
  const checkouts = NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((project) => project.isDirectory())
    .flatMap((project) =>
      NodeFS.readdirSync(NodePath.join(directory, project.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(directory, project.name, entry.name)),
    )
    .filter((checkout) => NodeFS.existsSync(NodePath.join(checkout, ".git")));
  for (const checkout of checkouts) {
    try {
      const commonDir = sh(
        `git -C ${shellQuote(checkout)} rev-parse --path-format=absolute --git-common-dir`,
      ).trim();
      sh(`git --git-dir=${shellQuote(commonDir)} worktree remove --force ${shellQuote(checkout)}`);
      log(`removed worktree ${checkout}`);
    } catch (error) {
      log(`could not remove worktree ${checkout} through git (${String(error)}); deleting it`);
    }
  }
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

async function runLaptopStep(step: LabLaptopStep): Promise<void> {
  switch (step.kind) {
    case "quit": {
      const target = {
        appImage: NodeFS.existsSync(step.appImage)
          ? NodeFS.realpathSync(step.appImage)
          : step.appImage,
        executableName: step.executableName,
        uid: process.getuid?.() ?? -1,
      };
      const main = selectLabMainProcess(listProcesses(), target);
      if (main === undefined) {
        log("Lab is not running");
        return;
      }
      // Re-read right before the signal: a PID reused since the scan has another start time.
      if (readProcess(main.pid)?.startTime !== main.startTime) {
        throw new Error(
          `Lab's process ${main.pid} changed before it could be quit; nothing changed.`,
        );
      }
      log(`quitting Lab (pid ${main.pid})`);
      process.kill(main.pid, "SIGTERM");
      for (let waited = 0; isAlive(main.pid); waited += 500) {
        if (waited > 30_000) throw new Error(`Lab (pid ${main.pid}) did not quit in 30 s.`);
        await NodeTimersPromises.setTimeout(500);
      }
      return;
    }
    case "backup-db": {
      const pendingBackup = readPendingBackup(step.pendingMarker);
      const choice = chooseResetBackup({
        pendingBackup,
        pendingBackupExists: pendingBackup !== undefined && NodeFS.existsSync(pendingBackup),
        sourceExists: NodeFS.existsSync(step.source),
        destination: step.destination,
      });
      if (choice === undefined) {
        log("Lab has no database yet; nothing to back up");
        return;
      }
      if (!choice.create) {
        log(`resuming an interrupted reset from ${choice.backup}`);
        return;
      }
      NodeFS.mkdirSync(NodePath.dirname(step.destination), { recursive: true });
      NodeFS.rmSync(step.destination, { force: true });
      {
        using source = new NodeSqlite.DatabaseSync(step.source, { readOnly: true });
        source.prepare("VACUUM INTO ?").run(step.destination);
      }
      NodeFS.writeFileSync(step.pendingMarker, `${JSON.stringify({ backup: step.destination })}\n`);
      log(`backed up ${step.source} to ${step.destination}`);
      return;
    }
    case "remove-worktrees":
      removeWorktrees(step.directory);
      return;
    case "delete-databases": {
      const present = NodeFS.existsSync(step.stateDirectory)
        ? labDatabasePaths(step.stateDirectory, NodeFS.readdirSync(step.stateDirectory))
        : [];
      for (const path of new Set([...step.paths, ...present])) {
        NodeFS.rmSync(path, { force: true });
      }
      log("deleted Lab's databases");
      return;
    }
    case "migrate-db":
      if (step.sha256 !== null && sha256File(step.appImage) !== step.sha256) {
        throw new Error(
          `${step.appImage} is not the staged build (hash differs); nothing migrated.`,
        );
      }
      sh(
        `${bundledCliScript(step.appImage, ["auth", "session", "list", "--base-dir", step.baseDir])} >/dev/null`,
      );
      log("created and migrated a fresh database");
      return;
    case "restore-auth": {
      const backup = readPendingBackup(step.pendingMarker);
      if (backup === undefined || !NodeFS.existsSync(backup)) {
        log("no backup; no sign-ins to restore");
        return;
      }
      for (const copy of await copyLabAuthRows(backup, step.destination)) {
        log(
          `${copy.table}: ${copy.skipped ?? `${copy.copiedRows} row(s)`}${copy.droppedColumns.length > 0 ? `, dropped ${copy.droppedColumns.join(", ")}` : ""}`,
        );
      }
      return;
    }
    case "relaunch": {
      sh(
        hyprlandExecScript(
          `env HOME=${shellQuote(step.laptopHome)} ${shellQuote(step.executable)}`,
        ),
      );
      log(`relaunched; waiting for ${step.readinessUrl}`);
      sh(readinessWaitScript(step.readinessUrl, READINESS_WAIT_SECONDS));
      // Keep only this reset's backup, as the rollback reference for the image now running.
      const kept = readPendingBackup(step.pendingMarker);
      const directory = NodePath.dirname(step.pendingMarker);
      for (const entry of NodeFS.readdirSync(directory)) {
        const path = NodePath.join(directory, entry);
        if (entry.startsWith(LAB_BACKUP_PREFIX) && path !== kept)
          NodeFS.rmSync(path, { force: true });
      }
      NodeFS.rmSync(step.pendingMarker, { force: true });
      log("Lab is ready");
      return;
    }
  }
}

/** Entry point of the bundled laptop half; `argv[0]` is the JSON list of laptop steps. */
export async function runLabResetOnLaptop(argv: ReadonlyArray<string>): Promise<void> {
  const steps = JSON.parse(argv[0] ?? "[]") as ReadonlyArray<LabLaptopStep>;
  for (const step of steps) await runLaptopStep(step);
}
