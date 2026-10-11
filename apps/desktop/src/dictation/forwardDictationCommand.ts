import type { DictationKeybindingCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DICTATION_COMMAND_LINE_CHANNEL } from "../ipc/channels.ts";

/**
 * Hands a dictation command to the main window's renderer, which runs it. Both ways in use it:
 * a `--dictation …` second launch (`DesktopClerk`) and the dictation socket
 * (`DesktopDictationWidget`). Without a window there is no dictation to steer, so it is dropped.
 */
export const forwardDictationCommand = (command: DictationKeybindingCommand) =>
  Effect.gen(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const mainWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(mainWindow)) {
      mainWindow.value.webContents.send(DICTATION_COMMAND_LINE_CHANNEL, command);
    }
  });
