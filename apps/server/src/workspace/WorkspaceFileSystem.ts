// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks. Reads also accept absolute host
 * paths so clients can show files an agent left outside the workspace; writes
 * never leave the root.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "watch",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /**
     * Resolve a workspace-relative path to its real location, rejecting one
     * that escapes the workspace root once symlinks are followed.
     *
     * Shared with the file watcher so the escape checks have one definition.
     */
    readonly resolveRealFilePath: (input: ProjectReadFileInput) => Effect.Effect<
      {
        readonly realWorkspaceRoot: string;
        readonly realTargetPath: string;
        /** The root-relative path as `WorkspacePaths` normalised it. */
        readonly relativePath: string;
      },
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Read a UTF-8 text file relative to the workspace root, or any host file by
     * absolute path.
     */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const resolveRealFilePath: WorkspaceFileSystem["Service"]["resolveRealFilePath"] = Effect.fn(
    "WorkspaceFileSystem.resolveRealFilePath",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { realWorkspaceRoot, relativePath: target.relativePath, realTargetPath };
  });

  /**
   * Resolves the file a read targets. Workspace-relative paths must stay inside the
   * root, symlinks included. An absolute path reads a host file in place, such as a
   * report an agent wrote to a temp directory; it gets no root check.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return { relativePath: requestedPath, realTargetPath };
    }

    // A workspace-relative read is exactly the escape-checked resolution the
    // file watcher shares, so both go through one definition rather than two
    // copies of the symlink checks.
    const { relativePath, realTargetPath } = yield* resolveRealFilePath(input);
    return { relativePath, realTargetPath };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    // Through `resolveReadTarget`, so an absolute host path reads in place;
    // a workspace-relative one still goes through the escape checks.
    const { realTargetPath, relativePath } = yield* resolveReadTarget(input);

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. Windows lacks it.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ resolveRealFilePath, readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
