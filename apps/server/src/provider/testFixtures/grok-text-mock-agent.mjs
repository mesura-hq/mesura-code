import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "grok-text-session";
let currentModelId = "grok-mock-default";
const models = ["grok-mock-default", "grok-mock-alt"];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// Mesura: mimic Grok Build, which keeps each session under
// `$GROK_HOME/sessions/<encoded cwd>/<session id>/updates.jsonl`, for the
// thread search tests that check a step removes only the session it created.
const writeGrokSessionTranscript = (cwd) => {
  const grokHome = process.env.GROK_HOME;
  if (process.env.T3_ACP_WRITE_GROK_SESSION !== "1" || !grokHome) return;
  const project = process.env.T3_ACP_GROK_SESSION_PROJECT ?? encodeURIComponent(cwd);
  const directory = `${grokHome}/sessions/${project}/${sessionId}`;
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(`${directory}/updates.jsonl`, '{"type":"turn_completed"}\n');
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.T3_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
  }
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "grok", version: "mock" },
        agentCapabilities: {},
      };
      break;
    case "session/new":
      writeGrokSessionTranscript(request.params.cwd);
      result = {
        sessionId,
        models: {
          currentModelId,
          availableModels: models.map((modelId) => ({ modelId, name: modelId })),
        },
      };
      break;
    case "session/set_model":
      if (!models.includes(request.params.modelId)) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unknown Grok model" },
        });
        continue;
      }
      currentModelId = request.params.modelId;
      result = {};
      break;
    case "session/prompt":
      if (process.env.T3_ACP_SESSION_PROBE_PORT) {
        const { createConnection } = await import("node:net");
        const probe = createConnection(
          Number(process.env.T3_ACP_SESSION_PROBE_PORT),
          "127.0.0.1",
          () => {
            probe.write(process.pid + "\n");
          },
        );
      }
      // Mesura: a step cancelled mid-prompt; the process is killed, never answered.
      if (process.env.T3_ACP_HANG_PROMPT_FOREVER === "1") continue;
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.T3_ACP_PROMPT_RESPONSE_TEXT ?? "" },
          },
        },
      });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
