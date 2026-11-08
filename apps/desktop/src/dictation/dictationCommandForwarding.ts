import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DICTATION_COMMAND_LINE_CHANNEL } from "../ipc/channels.ts";
import { parseDictationCommandLine } from "./dictationCommandLine.ts";

/**
 * Sends the dictation command in `argv` to the main window's renderer, without showing the
 * window, and tells whether `argv` carried one. The `second-instance` handler and the session
 * socket both reach the running dictation through here; any other argv is left to the caller.
 */
export const forwardDictationCommand = Effect.fn("desktop.dictation.forwardCommand")(function* (
  argv: ReadonlyArray<string>,
) {
  const command = parseDictationCommandLine(argv);
  if (command === null) return false;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const mainWindow = yield* electronWindow.currentMainOrFirst;
  if (Option.isSome(mainWindow)) {
    mainWindow.value.webContents.send(DICTATION_COMMAND_LINE_CHANNEL, command);
  }
  return true;
});
