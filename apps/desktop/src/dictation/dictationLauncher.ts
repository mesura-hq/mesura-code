// @effect-diagnostics nodeBuiltinImport:off -- Pure path resolution for a command line.
import * as NodePath from "node:path";

import { DICTATION_FLAG } from "./dictationCommandLine.ts";

/** The variables that decide which instance a second launch reaches. */
const INSTANCE_ENVIRONMENT = ["XDG_CONFIG_HOME", "T3CODE_HOME"] as const;

/**
 * The command a Hyprland bind runs to reach this instance: a second launch of the same app,
 * which the single-instance lock hands to this one.
 *
 * Packaged, that is the AppImage or the executable. In development Electron needs the entry
 * script, as an absolute path because Hyprland does not run binds from the app's directory,
 * and the switches this process was started with (`--no-sandbox`, `--t3code-dev-root=…`).
 *
 * Hyprland runs binds with its own environment, not this process's. The lock lives in the
 * userData directory, `$XDG_CONFIG_HOME/<app>`, and the server state in `T3CODE_HOME`, so an
 * instance isolated through either variable (a side-by-side test install, for one) is reached
 * only when the bind line carries them; they go on it through `env` whenever they are set.
 * Development mode itself comes from `VITE_DEV_SERVER_URL` being set, so that variable also
 * goes on the line in development.
 */
export function resolveDictationLauncher(input: {
  readonly appImagePath: string | null;
  readonly isDevelopment: boolean;
  readonly execPath: string;
  /** `process.argv` of this process. */
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ReadonlyArray<string> {
  const environment = (
    input.isDevelopment
      ? (["VITE_DEV_SERVER_URL", ...INSTANCE_ENVIRONMENT] as const)
      : INSTANCE_ENVIRONMENT
  ).flatMap((name) => {
    const value = input.env[name]?.trim();
    return value ? [`${name}=${value}`] : [];
  });
  const withEnvironment = (command: ReadonlyArray<string>) =>
    environment.length > 0 ? ["env", ...environment, ...command] : command;

  if (input.appImagePath) return withEnvironment([input.appImagePath]);
  if (!input.isDevelopment) return withEnvironment([input.execPath]);

  const launchArguments = input.argv.slice(1);
  const dictationIndex = launchArguments.indexOf(DICTATION_FLAG);
  const ownArguments =
    dictationIndex < 0 ? launchArguments : launchArguments.slice(0, dictationIndex);
  const entry = ownArguments.find((argument) => !argument.startsWith("-"));
  // A second process cannot share this one's debugging or inspector port.
  const switches = ownArguments.filter(
    (argument) =>
      argument.startsWith("--") &&
      !argument.startsWith("--remote-debugging-port") &&
      !argument.startsWith("--inspect"),
  );
  return withEnvironment([
    input.execPath,
    ...switches,
    ...(entry === undefined ? [] : [NodePath.resolve(input.cwd, entry)]),
  ]);
}
