/**
 * T3ProjectFileLoader - Effect service that loads repository defaults from
 * `.mesura.json` and the legacy `t3.json` at a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module T3ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  MESURA_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile,
} from "@t3tools/contracts";
import {
  MesuraProjectFileFromJson,
  type RepositoryDefaults,
  resolveRepositoryDefaults,
  T3ProjectFileFromJson,
} from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);
const decodeMesuraProjectFileJson = Schema.decodeEffect(MesuraProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedError<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    fileName: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${this.fileName ?? T3_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for repository file loading. */
export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /**
     * Load and decode `t3.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
    /** Read both files in this checkout and resolve their defaults independently per field. */
    readonly loadRepositoryDefaults: (workspaceRoot: string) => Effect.Effect<RepositoryDefaults>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadFile = Effect.fn("T3ProjectFileLoader.loadFile")(function* <Value>(
    workspaceRoot: string,
    fileName: string,
    decode: (contents: string) => Effect.Effect<Value, Schema.SchemaError>,
  ) {
    const filePath = path.join(workspaceRoot, fileName);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logT3ProjectFileLoadError(
                new T3ProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  fileName,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<Value>();
    }
    return yield* decode(raw.value).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SchemaError: (error) =>
          logT3ProjectFileLoadError(
            new T3ProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              fileName,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<Value>())),
      }),
    );
  });

  const load: T3ProjectFileLoader["Service"]["load"] = (workspaceRoot) =>
    loadFile(workspaceRoot, T3_PROJECT_FILE_NAME, decodeT3ProjectFileJson);

  const loadRepositoryDefaults = Effect.fn("T3ProjectFileLoader.loadRepositoryDefaults")(function* (
    workspaceRoot: string,
  ) {
    const [mesura, legacy] = yield* Effect.all([
      loadFile(workspaceRoot, MESURA_PROJECT_FILE_NAME, decodeMesuraProjectFileJson),
      load(workspaceRoot),
    ]);
    return resolveRepositoryDefaults(Option.getOrNull(mesura), Option.getOrNull(legacy));
  });

  return T3ProjectFileLoader.of({ load, loadRepositoryDefaults });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
