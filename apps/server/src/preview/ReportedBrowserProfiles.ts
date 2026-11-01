import { PreviewReportProfilesInput } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const SavedProfiles = Schema.Struct({
  profiles: PreviewReportProfilesInput.fields.profiles,
  defaultProfileId: PreviewReportProfilesInput.fields.defaultProfileId,
});
type SavedProfiles = typeof SavedProfiles.Type;
const SavedProfilesJson = Schema.fromJsonString(SavedProfiles);
const decodeSavedProfiles = Schema.decodeUnknownEffect(SavedProfilesJson);
const encodeSavedProfiles = Schema.encodeEffect(SavedProfilesJson);

/** The client's last profile report, so agent tabs keep its profiles before any client reconnects. */
export const loadReportedProfiles = Effect.fn("ReportedBrowserProfiles.load")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeSavedProfiles),
    Effect.asSome,
    Effect.catch((cause) =>
      "reason" in cause && cause.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.logWarning("Ignoring unreadable saved browser profiles.", {
            filePath,
            cause,
          }).pipe(Effect.as(Option.none<SavedProfiles>())),
    ),
  );
});

export const saveReportedProfiles = Effect.fn("ReportedBrowserProfiles.save")(function* (
  filePath: string,
  report: PreviewReportProfilesInput,
) {
  const saved: SavedProfiles = {
    profiles: report.profiles,
    defaultProfileId: report.defaultProfileId,
  };
  yield* encodeSavedProfiles(saved).pipe(
    Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
    Effect.catch((cause) =>
      Effect.logWarning("Could not save the reported browser profiles.", { filePath, cause }),
    ),
  );
});
