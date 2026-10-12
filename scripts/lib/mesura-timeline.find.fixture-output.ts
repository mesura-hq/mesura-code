// @effect-diagnostics nodeBuiltinImport:off - Owns only an isolated browser fixture's filesystem output.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** A returned handle owns its directory. Failed exclusive creation returns no cleanup authority. */
export function createTimelineFixtureOutput(retainedDirectory?: string) {
  const directory = retainedDirectory
    ? NodePath.resolve(retainedDirectory)
    : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mesura-timeline-find-"));
  if (retainedDirectory) NodeFS.mkdirSync(directory, { mode: 0o700 });
  return {
    directory,
    writeReceipt(name: string, receipt: unknown) {
      if (retainedDirectory)
        NodeFS.writeFileSync(NodePath.join(directory, name), JSON.stringify(receipt, null, 2), {
          mode: 0o600,
          flag: "wx",
        });
    },
    dispose() {
      if (retainedDirectory) {
        for (const name of ["fixture.html", "fixture.bundle.js", ".cache"])
          NodeFS.rmSync(NodePath.join(directory, name), { recursive: true, force: true });
      } else NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}
