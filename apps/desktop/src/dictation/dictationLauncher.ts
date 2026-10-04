// @effect-diagnostics nodeBuiltinImport:off -- Pure path resolution for a command line.
import * as NodePath from "node:path";

import { DICTATION_FLAG } from "./dictationCommandLine.ts";

/**
 * The command a Hyprland bind runs to reach this instance: a second launch of the same app,
 * which the single-instance lock hands to this one.
 *
 * Packaged, that is the AppImage or the executable alone. In development Electron needs the
 * entry script, as an absolute path because Hyprland does not run binds from the app's
 * directory, and the switches this process was started with (`--no-sandbox`,
 * `--t3code-dev-root=…`). The lock lives in the userData directory, which in development is
 * `$XDG_CONFIG_HOME/mesura-code-dev`: development mode comes from `VITE_DEV_SERVER_URL` being
 * set, so that variable, and `XDG_CONFIG_HOME` when set, go on the line through `env`.
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
  if (input.appImagePath) return [input.appImagePath];
  if (!input.isDevelopment) return [input.execPath];

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
  const environment = (["VITE_DEV_SERVER_URL", "XDG_CONFIG_HOME"] as const).flatMap((name) => {
    const value = input.env[name]?.trim();
    return value ? [`${name}=${value}`] : [];
  });
  return [
    ...(environment.length > 0 ? ["env", ...environment] : []),
    input.execPath,
    ...switches,
    ...(entry === undefined ? [] : [NodePath.resolve(input.cwd, entry)]),
  ];
}
