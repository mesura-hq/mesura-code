// @effect-diagnostics nodeBuiltinImport:off - This file shares the prototype's Node filesystem validation boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { openMediaFile, readMediaFileHeader } from "../assets/MediaFile.ts";
import {
  isProjectImagePath,
  PROJECT_ICON_MAX_BYTES,
  validateProjectIconCandidate,
} from "./ProjectIconCandidates.ts";

const IMPORT_DIRECTORY_SEGMENTS = [".mesura", "project-icons"] as const;
const WRITER_TIMEOUT_MS = 15_000;

export class ProjectIconFileError extends Schema.TaggedError<ProjectIconFileError>()(
  "ProjectIconFileError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Where a requested image lives, decided before anything is written. */
export type ProjectIconSource =
  /** Already inside the project: saved in place, never copied. */
  | { readonly kind: "project"; readonly faviconPath: string }
  /** In the thread's worktree (`root`): copied into the project. */
  | { readonly kind: "worktree"; readonly source: string; readonly root: string }
  /**
   * In the shared attachments directory (`root`): copied into the project once
   * the caller confirms this thread recorded `fileName` on one of its messages.
   */
  | {
      readonly kind: "attachment";
      readonly source: string;
      readonly root: string;
      readonly fileName: string;
    };

/** A missing or unreadable file is not a candidate rather than an error. */
const isCandidateWithin = (root: string, file: string) =>
  validateProjectIconCandidate(root, file).catch(() => false);

const isWithin = (root: string, absolute: string) => {
  const relative = NodePath.relative(root, absolute);
  return !(
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  );
};

/**
 * Classifies `imagePath` (relative to the thread's working directory, or
 * absolute) as a project, worktree or attachment image. Containment follows
 * symlinks, and the type and 2 MiB limits apply. It writes nothing; an import
 * reads the file again through `readProjectIconSource`.
 */
export async function locateProjectIconSource(input: {
  workspaceRoot: string;
  workingDirectory: string;
  attachmentsDirectory: string;
  imagePath: string;
}): Promise<ProjectIconSource> {
  const source = NodePath.resolve(input.workingDirectory, input.imagePath);
  if (await isCandidateWithin(input.workspaceRoot, source)) {
    const root = await NodeFSP.realpath(input.workspaceRoot);
    const file = await NodeFSP.realpath(source);
    return {
      kind: "project",
      faviconPath: NodePath.relative(root, file).split(NodePath.sep).join("/"),
    };
  }
  if (await isCandidateWithin(input.workingDirectory, source)) {
    return { kind: "worktree", source, root: input.workingDirectory };
  }
  if (await isCandidateWithin(input.attachmentsDirectory, source)) {
    const directory = await NodeFSP.realpath(input.attachmentsDirectory);
    const fileName = NodePath.relative(directory, await NodeFSP.realpath(source));
    // Attachments are stored flat; a nested path is not one of them.
    if (!fileName.includes(NodePath.sep)) {
      return { kind: "attachment", source, root: input.attachmentsDirectory, fileName };
    }
  }
  throw new Error(
    "Choose an image inside this project, its worktree, or this thread's attachments.",
  );
}

const sourceChanged = () =>
  new ProjectIconFileError({ detail: "The image changed while it was being imported." });

/**
 * Reads an image to import, after every authorization step, from the file it
 * names now: still inside `root`, still an image type, at most 2 MiB. The file
 * is opened once and read through that descriptor (`openMediaFile` checks
 * that the path and descriptor are one file), and never more than the limit
 * plus one byte is read, so a swap or growth after `locateProjectIconSource`
 * cannot import another file or an oversized one.
 */
export const readProjectIconSource = Effect.fn("readProjectIconSource")(function* (source: {
  readonly source: string;
  readonly root: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const [file, root] = yield* Effect.all([
    fileSystem.realPath(source.source),
    fileSystem.realPath(source.root),
  ]).pipe(Effect.mapError(sourceChanged));
  if (!isWithin(root, file) || !isProjectImagePath(file)) return yield* sourceChanged();
  const opened = yield* openMediaFile(file).pipe(Effect.mapError(sourceChanged));
  if (opened === null) return yield* sourceChanged();
  if (opened.info.size === 0n || opened.info.size > BigInt(PROJECT_ICON_MAX_BYTES)) {
    return yield* new ProjectIconFileError({ detail: "The image must be at most 2 MiB." });
  }
  const bytes = yield* readMediaFileHeader(file, opened, PROJECT_ICON_MAX_BYTES + 1).pipe(
    Effect.mapError(sourceChanged),
  );
  if (bytes.length === 0 || bytes.length > PROJECT_ICON_MAX_BYTES) {
    return yield* new ProjectIconFileError({ detail: "The image must be at most 2 MiB." });
  }
  return { bytes: Buffer.from(bytes), extension: NodePath.extname(file).toLowerCase() };
}, Effect.scoped);

/**
 * Runs inside the writer process. Each directory is entered with `chdir`, then
 * checked: the kernel holds the current directory by identity, so once the
 * check passes every later operation is relative to that very directory and a
 * symlink swapped in above it cannot redirect it. A segment that is a link,
 * or a path that no longer names the entered directory, stops the write.
 */
const WRITER_SCRIPT = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { root, segments, name, maxBytes } = JSON.parse(process.argv[1]);
const fail = (message) => {
  process.stderr.write(message);
  process.exit(2);
};
const enter = (target, expected) => {
  process.chdir(target);
  const entered = fs.statSync(".", { bigint: true });
  const named = fs.lstatSync(expected, { bigint: true });
  if (
    named.isSymbolicLink() ||
    !named.isDirectory() ||
    named.dev !== entered.dev ||
    named.ino !== entered.ino ||
    path.resolve(process.cwd()) !== expected
  ) {
    fail("The project icon directory is a link or moved outside the project.");
  }
};
const bytes = fs.readFileSync(0);
if (bytes.length === 0 || bytes.length > maxBytes) fail("The image must be at most 2 MiB.");
enter(root, root);
let expected = root;
for (const segment of segments) {
  try {
    fs.mkdirSync(segment);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  expected = path.join(expected, segment);
  enter(segment, expected);
}
try {
  // O_EXCL creates the name or fails; it never follows a link at the name.
  const descriptor = fs.openSync(name, "wx");
  try {
    fs.writeFileSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const existing = fs.lstatSync(name);
  if (existing.isSymbolicLink() || !existing.isFile() || existing.size !== bytes.length) {
    fail("A different file already uses this project icon name.");
  }
  const descriptor = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = Buffer.alloc(bytes.length + 1);
    const read = fs.readSync(descriptor, current, 0, current.length, 0);
    if (read !== bytes.length || !current.subarray(0, read).equals(bytes)) {
      fail("A different file already uses this project icon name.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
`;

/**
 * WORKAROUND: creates the import directories and file from a short-lived child
 * process that walks them with `chdir`.
 * Why: a pathname write (even with `wx`) re-resolves every ancestor, so a
 * `.mesura` or `project-icons` symlink swapped in after a check redirects it
 * outside the project. The clean fix is directory-relative `openat`/`mkdirat`
 * with no symlink traversal, which Node does not expose, and the server's own
 * cwd is process-wide, so it must never change. A child's cwd pins each
 * checked directory on every platform the server runs on. The child is
 * `process.execPath`; the desktop backend already runs it with
 * `ELECTRON_RUN_AS_NODE=1`, which the child inherits.
 * Remove once Node ships directory-handle relative file operations.
 */
function writeInPinnedDirectories(input: {
  readonly root: string;
  readonly name: string;
  readonly bytes: Buffer;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        WRITER_SCRIPT,
        JSON.stringify({
          root: input.root,
          segments: IMPORT_DIRECTORY_SEGMENTS,
          name: input.name,
          maxBytes: PROJECT_ICON_MAX_BYTES,
        }),
      ],
      {
        stdio: ["pipe", "ignore", "pipe"],
        timeout: WRITER_TIMEOUT_MS,
        windowsHide: true,
        // Node 26's default spawn path reads the native environment even after
        // process.env is replaced. Pass the current settings to the writer.
        env: process.env,
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new ProjectIconFileError({
              detail:
                code === 2 && stderr.length > 0
                  ? stderr
                  : "Could not write the image into the project.",
            }),
          ),
    );
    child.stdin.on("error", reject);
    child.stdin.end(input.bytes);
  });
}

/**
 * Copies validated image bytes into `.mesura/project-icons/<sha256>.<ext>` and
 * returns that project-relative path. The name is content-addressed, so a
 * repeat reuses the same file; the source is never changed.
 */
export async function writeProjectIconFile(input: {
  readonly workspaceRoot: string;
  readonly bytes: Buffer;
  readonly extension: string;
}): Promise<string> {
  const digest = NodeCrypto.createHash("sha256").update(input.bytes).digest("hex");
  const name = `${digest}${input.extension}`;
  const root = await NodeFSP.realpath(input.workspaceRoot);
  await writeInPinnedDirectories({ root, name, bytes: input.bytes });
  const faviconPath = [...IMPORT_DIRECTORY_SEGMENTS, name].join("/");
  if (!(await isCandidateWithin(root, NodePath.join(root, ...IMPORT_DIRECTORY_SEGMENTS, name)))) {
    throw new ProjectIconFileError({ detail: "The imported image is not a valid project icon." });
  }
  return faviconPath;
}
