/**
 * Writes the generated JSON Schema artifacts under `schema/`.
 *
 * Run it with `vp run generate` from inside the package. Every file it writes
 * is derived from the Effect schemas in `src/`, so a schema change followed by
 * a run is the only way an artifact ever changes. Nothing under `schema/` is
 * edited by hand, and the suite fails if it is.
 *
 * The script holds no logic of its own beyond reading and writing files: the
 * documents, the index and the checksum are all built by `src/jsonSchema.ts`,
 * which the tests use directly.
 */
// @effect-diagnostics nodeBuiltinImport:off - a build script writes files with
// the platform API rather than through an Effect runtime it would have to boot.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { buildSymmetriaSchemaArtifactSet } from "../src/jsonSchema.ts";

const schemaDirectory = NodeURL.fileURLToPath(new URL("../schema/", import.meta.url));

const artifacts = buildSymmetriaSchemaArtifactSet();
const written = new Set(artifacts.map((artifact) => artifact.file));

NodeFS.mkdirSync(schemaDirectory, { recursive: true });

// A root that stops existing has to take its document with it, or the index and
// the checksum would disagree with the directory forever after.
for (const entry of NodeFS.readdirSync(schemaDirectory, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".json") && !written.has(entry.name)) {
    NodeFS.rmSync(NodePath.join(schemaDirectory, entry.name));
  }
}

for (const artifact of artifacts) {
  NodeFS.writeFileSync(NodePath.join(schemaDirectory, artifact.file), artifact.source, "utf8");
}

process.stdout.write(
  `emitted ${String(artifacts.length)} JSON Schema artifacts to ${schemaDirectory}\n`,
);
