import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the desktop keeps its shared data, most-specific first.
 *
 * The user's own directory wins, which is what lets a locally installed
 * program's MIME types and desktop entries take precedence over the system's.
 *
 * One definition, because there were two: the MIME database loader and the
 * desktop-entry reader each had their own, and a fix to one would have silently
 * left the other resolving from a different set of directories.
 */
export function dataDirectories(): string[] {
  const home = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  const system = process.env["XDG_DATA_DIRS"] ?? "/usr/local/share:/usr/share";

  return [home, ...system.split(":").filter((dir) => dir !== "")];
}
