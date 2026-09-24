// @effect-diagnostics nodeBuiltinImport:off - This build script writes the generated schema without starting an Effect runtime.
import * as NodeFS from "node:fs";

import { buildMesuraProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

NodeFS.writeFileSync(
  new URL("../packages/contracts/mesura.schema.json", import.meta.url),
  `${JSON.stringify(buildMesuraProjectFileJsonSchema(), null, 2)}\n`,
);
