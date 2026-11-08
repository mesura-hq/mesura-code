import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { resolveDesktopUserDataIdentity } from "../../../../scripts/lib/brand-assets.ts";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

export interface DesktopUserDataDirectoryNames {
  readonly current: string;
  readonly legacy: string;
}

/**
 * Mesura: the profile directory names come from `DESKTOP_USER_DATA_IDENTITY`,
 * never from upstream's `t3code-v2` / `T3 Code (Alpha)` literals. Electron scopes
 * its single-instance lock to this directory, so sharing a name with the
 * separately installed T3 Code makes whichever app starts second quit silently.
 */
export const resolveUserDataDirectoryNames = (
  isDevelopment: boolean,
): DesktopUserDataDirectoryNames => {
  const identity = resolveDesktopUserDataIdentity(isDevelopment);
  return { current: identity.userDataDirName, legacy: identity.legacyUserDataDirName };
};

/** Select Electron's profile independently of the server home. */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    /** Tests pass distinct names to exercise the legacy and Windows migration branches. */
    readonly directoryNames?: DesktopUserDataDirectoryNames;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = input.directoryNames ?? resolveUserDataDirectoryNames(input.isDevelopment);
    const destinationPath = path.join(input.appDataDirectory, names.current);
    const legacyPath = path.join(input.appDataDirectory, names.legacy);
    const inspect = (resourcePath: string) =>
      fs
        .exists(resourcePath)
        .pipe(
          Effect.mapError((cause) =>
            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
          ),
        );
    if (input.isDevelopment) {
      return (yield* inspect(legacyPath)) ? legacyPath : destinationPath;
    }
    // Chromium databases require their own profile for each running version.
    if (input.platform !== "win32") return destinationPath;
    const destinationState = path.join(destinationPath, "Local State");
    if (yield* inspect(destinationState)) return destinationPath;
    const legacyState = path.join(legacyPath, "Local State");
    // Mesura: upstream falls back to its pre-V2 `t3code` profile here. That
    // directory belongs to the installed T3 Code, so this fork never copies its
    // safeStorage keys and only migrates from the legacy name.
    if (!(yield* inspect(legacyState))) return destinationPath;
    const sourceState = legacyState;
    // Windows safeStorage keys live here. Copy only these preferences, never locked databases.
    const state = yield* fs
      .readFileString(sourceState)
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "read", sourceState),
        ),
      );
    yield* fs
      .makeDirectory(destinationPath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(
            cause,
            "create-directory",
            destinationPath,
          ),
        ),
      );
    yield* fs.writeFileString(destinationState, state, { flag: "wx" }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
      Effect.mapError((cause) =>
        DesktopUserDataInitializationError.fromFileSystem(cause, "write", destinationState),
      ),
    );
    return destinationPath;
  },
);
