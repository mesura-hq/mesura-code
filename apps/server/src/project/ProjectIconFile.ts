// @effect-diagnostics nodeBuiltinImport:off - This file shares the prototype's Node filesystem validation boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { validateProjectIconCandidate } from "./ProjectIconCandidates.ts";

/** Keep attached images and worktree images in the project's own directory. */
export async function prepareProjectIconFile(input: {
  workspaceRoot: string;
  workingDirectory: string;
  attachmentsDirectory: string;
  imagePath: string;
}): Promise<{ faviconPath: string; imported: boolean }> {
  const source = NodePath.resolve(input.workingDirectory, input.imagePath);
  if (await validateProjectIconCandidate(input.workspaceRoot, source)) {
    const root = await NodeFSP.realpath(input.workspaceRoot);
    const file = await NodeFSP.realpath(source);
    return {
      faviconPath: NodePath.relative(root, file).split(NodePath.sep).join("/"),
      imported: false,
    };
  }
  const allowed =
    (await validateProjectIconCandidate(input.workingDirectory, source)) ||
    (await validateProjectIconCandidate(input.attachmentsDirectory, source));
  if (!allowed)
    throw new Error(
      "Choose an image inside this project, its worktree, or the thread attachments.",
    );

  const bytes = await NodeFSP.readFile(source);
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const faviconPath = `.mesura/project-icons/${digest}${NodePath.extname(source).toLowerCase()}`;
  const destination = NodePath.join(input.workspaceRoot, faviconPath);
  const directory = NodePath.dirname(destination);
  await NodeFSP.mkdir(directory, { recursive: true });
  const root = await NodeFSP.realpath(input.workspaceRoot);
  const relative = NodePath.relative(root, await NodeFSP.realpath(directory));
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    throw new Error("The project icon directory points outside the project.");
  await NodeFSP.writeFile(destination, bytes, { flag: "wx" }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  if (!(await validateProjectIconCandidate(input.workspaceRoot, destination)))
    throw new Error("The imported image is not a valid project icon.");
  return { faviconPath, imported: true };
}
