// @effect-diagnostics nodeBuiltinImport:off - This build script writes a generated source file without starting an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

const SOURCE = new URL("../packages/shared/src/embeddedDocumentAgent.ts", import.meta.url);
const OUTPUT = new URL("../packages/shared/src/embeddedDocumentAgentSource.ts", import.meta.url);

/**
 * The agent function as plain JavaScript: types, blank lines, trailing spaces and whole-line
 * comments gone. No string in the agent spans lines, so dropping a `//` line drops only a comment.
 */
export function renderEmbeddedDocumentAgent(source = NodeFS.readFileSync(SOURCE, "utf8")): string {
  const stripped = NodeModule.stripTypeScriptTypes(source, { mode: "strip" });
  const start = stripped.indexOf("function embeddedDocumentAgent(");
  if (start === -1)
    throw new Error("embeddedDocumentAgent.ts no longer declares the agent function");
  return stripped
    .slice(start)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.trimStart().startsWith("//"))
    .join("\n");
}

if (import.meta.main) {
  NodeFS.writeFileSync(
    OUTPUT,
    [
      "// Generated from embeddedDocumentAgent.ts. Run node scripts/generate-embedded-document-agent.ts",
      "// from the repository root, then vp fmt this file.",
      `export const EMBEDDED_DOCUMENT_AGENT_SOURCE = ${JSON.stringify(renderEmbeddedDocumentAgent())};`,
      "",
    ].join("\n"),
  );
}
