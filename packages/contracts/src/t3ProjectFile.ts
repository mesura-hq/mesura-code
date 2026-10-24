import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ProjectScriptIcon } from "./project.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import type { ProjectScopedServerSettingKey, ServerSettings } from "./settings.ts";

export const T3_PROJECT_FILE_NAME = "t3.json";

export const T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";

const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const T3_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const T3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the Mesura Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a Mesura Code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  runOnSettle: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs in the thread's worktree each time the thread settles, for example to delete build output. Threads without their own worktree skip it.",
    }),
  ),
  async: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Only for runOnWorktreeCreate scripts. When true (the default), the agent starts while the script is still running. Set false to hold the agent until the script exits.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into Mesura Code.",
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;

export const T3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${T3_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Mesura Code\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in Mesura Code overrides this; when neither is set, the global default applies.',
    }),
  ),
  worktreeSubmodules: Schema.optionalKey(
    WorktreeSubmodules.annotate({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup script to handle. A project or environment setting in Mesura Code overrides this.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(T3ProjectFileScript)
      .annotate({
        description:
          "Project scripts shared with everyone who opens this repository in Mesura Code.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "T3 project file",
  description:
    "Checked-in project configuration for Mesura Code (t3.json at the repository root). See https://t3.codes for documentation.",
});
export type T3ProjectFile = typeof T3ProjectFile.Type;

export const MESURA_PROJECT_FILE_NAME = ".mesura.json";

const portableIconPath = trimmedNonEmpty(
  {
    description:
      "Workspace-relative icon path. Absolute paths and paths that escape the checkout are invalid. Use forward slashes as separators.",
  },
  T3_PROJECT_FILE_PATH_MAX_LENGTH,
).check(
  // Effect 4 exports regex constraints to JSON Schema only with the Unicode flag.
  Schema.isPattern(/^(?![A-Za-z]:)(?!\/)[^\\]+$/u),
  Schema.makeFilter(
    (value) => {
      if (value.includes("\0")) return false;
      let depth = 0;
      for (const segment of value.split("/")) {
        if (segment === "..") depth -= 1;
        else if (segment !== "." && segment !== "") depth += 1;
        if (depth < 0) return false;
      }
      return depth > 0;
    },
    { message: "The icon path must stay inside the checkout and name a file." },
  ),
);

/** A repository model names a driver, never an environment's provider instance. */
export const PortableModelSelection = Schema.Struct({
  provider: ProviderDriverKind,
  model: trimmedNonEmpty({ description: "Model slug understood by the provider driver." }),
  // Repository files have no legacy options object to migrate. Keep the canonical array.
  options: Schema.optionalKey(Schema.Array(ProviderOptionSelection)),
});
export type PortableModelSelection = typeof PortableModelSelection.Type;

/** Unknown versions fail as a whole so their fields cannot acquire version-1 semantics. */
export const MesuraProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: "Path to the local Mesura JSON Schema for editor validation.",
    }),
  ),
  version: Schema.Literal(1),
  iconPath: Schema.optionalKey(portableIconPath),
  defaultModelSelection: Schema.optionalKey(PortableModelSelection),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
}).annotate({
  title: "Mesura repository defaults",
  description: "Portable defaults for .mesura.json at the checkout root. Scripts stay in t3.json.",
});
export type MesuraProjectFile = typeof MesuraProjectFile.Type;
/**
 * A key here must be nullable on `ServerSettings` (null means inherit) so both
 * the project override and the environment value can defer to the file; `field`
 * names the t3.json field carrying the same value and `builtIn` is what applies
 * when every tier is unset.
 */
export const PROJECT_FILE_BACKED_SETTINGS = {
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "local" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  // `providerInstances` is scoped per project but overrides field by field
  // rather than replacing a whole `ServerSettings` value (see its doc comment
  // in settings.ts), so it cannot be file-backed and is excluded here.
  readonly [K in ProjectScopedServerSettingKey & keyof ServerSettings]?: {
    readonly field: {
      readonly [F in keyof T3ProjectFile]: T3ProjectFile[F] extends
        | Exclude<ServerSettings[K], null>
        | undefined
        ? F
        : never;
    }[keyof T3ProjectFile];
    readonly builtIn: Exclude<ServerSettings[K], null>;
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

export type ResolvedServerSettings = Omit<ServerSettings, ProjectFileBackedSettingKey> & {
  readonly [K in ProjectFileBackedSettingKey]: Exclude<ServerSettings[K], null>;
};
