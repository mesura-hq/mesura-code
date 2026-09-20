import { relativeToCwd } from "../mesuraTree/overviewModelFromEntries";

export type OpenFromFileManager =
  | { readonly kind: "editor"; readonly relativePath: string }
  | { readonly kind: "host" };

/**
 * Where a file activated in the file manager goes: a file under the thread's
 * project opens in the editor, by the relative path the editor keys files
 * on, and anything else is the host's to open with its own application.
 */
export function decideOpenFromFileManager(cwd: string, absolutePath: string): OpenFromFileManager {
  const relativePath = relativeToCwd(cwd, absolutePath);
  return relativePath === null || relativePath === ""
    ? { kind: "host" }
    : { kind: "editor", relativePath };
}
