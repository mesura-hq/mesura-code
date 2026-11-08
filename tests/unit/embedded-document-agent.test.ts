import { assert, it } from "vite-plus/test";

import { EMBEDDED_DOCUMENT_AGENT_SOURCE } from "../../packages/shared/src/embeddedDocumentAgentSource.ts";
import { renderEmbeddedDocumentAgent } from "../../scripts/generate-embedded-document-agent.ts";

it("the generated page agent matches its typed source", () => {
  assert.strictEqual(
    EMBEDDED_DOCUMENT_AGENT_SOURCE,
    renderEmbeddedDocumentAgent(),
    "embeddedDocumentAgent.ts changed: run node scripts/generate-embedded-document-agent.ts",
  );
});
