#!/usr/bin/env node
// Minimal `claude` stand-in that records the environment it was spawned with.
// Before it reads stdin it appends one JSON line to the file named by
// T3_SPAWN_ENVIRONMENT_LOG, so any message it writes proves the record is
// already on disk. Speaks enough of the Agent SDK's stream-json control
// protocol for the capability probe, the account-limit read, and a
// ClaudeAdapter session start. Stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

NodeFS.appendFileSync(
  process.env.T3_SPAWN_ENVIRONMENT_LOG,
  `${JSON.stringify({
    pid: process.pid,
    kind: "spawn",
    argv: process.argv.slice(2),
    providerProbeMarker: process.env.MESURA_PROVIDER_PROBE ?? null,
  })}\n`,
);

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.0 (Claude Code)\n");
  process.exit(0);
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (requestId, response) =>
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });

const lines = NodeReadline.createInterface({ input: process.stdin });
// Like the real CLI, end when the SDK closes stdin instead of waiting to be killed.
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type !== "control_request") return;
  const subtype = message.request?.subtype;
  if (subtype === "initialize") {
    reply(message.request_id, {
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [],
      account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
    });
    // A session reads this as its CLI-side init; probes ignore it.
    write({
      type: "system",
      subtype: "init",
      session_id: "claude-spawn-environment-peer",
      peer: "claudeSpawnEnvironmentPeer",
    });
    return;
  }
  if (subtype === "get_usage") {
    reply(message.request_id, {
      session: {},
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {},
      behaviors: null,
    });
    return;
  }
  reply(message.request_id, {});
});

// Keep the process alive until the SDK closes stdin or aborts it.
setInterval(() => {}, 1_000);
