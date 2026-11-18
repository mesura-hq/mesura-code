import type { BrowserMicrophone } from "../speech/browserMicrophones";
import type { MicrophoneEntry } from "../speech/microphoneOrder";

/**
 * The device ids to try, in the saved order, up to System default (`""`), which always ends the
 * list. A saved device is skipped when it is not connected; while the browser hides ids (before
 * microphone permission), every saved device is tried as saved.
 */
export function microphoneCandidates(
  order: ReadonlyArray<MicrophoneEntry>,
  devices: ReadonlyArray<BrowserMicrophone>,
): string[] {
  const idsHidden = devices.every((device) => !device.deviceId);
  const candidates: string[] = [];
  for (const entry of order) {
    if (entry.kind === "default") break;
    if (idsHidden || devices.some((device) => device.deviceId === entry.deviceId)) {
      candidates.push(entry.deviceId);
    }
  }
  candidates.push("");
  return candidates;
}
