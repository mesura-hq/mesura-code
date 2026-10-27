#!/usr/bin/env node
// `codex app-server` stand-in that records its spawn environment. It appends a `spawn` line
// to T3_SPAWN_ENVIRONMENT_LOG before reading stdin, so any response proves the record is on
// disk, then a `request` line with the same pid per answer. Answers just enough protocol for
// the provider probes and a CodexSessionRuntime session start. Stdlib only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const record = (entry) =>
  NodeFS.appendFileSync(
    process.env.T3_SPAWN_ENVIRONMENT_LOG,
    `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
  );

record({
  kind: "spawn",
  argv: process.argv.slice(2),
  providerProbeMarker: process.env.MESURA_PROVIDER_PROBE ?? null,
});

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const wire = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const results = {
  initialize: {
    userAgent: "codex-spawn-environment-peer/1.2.3",
    codexHome: "/tmp",
    platformFamily: "unix",
    platformOs: "linux",
  },
  "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: false },
  "skills/list": { data: [] },
  "model/list": { data: [] },
  "account/rateLimits/read": { rateLimits: {} },
  "account/rateLimitResetCredit/consume": { outcome: "nothingToReset" },
  "thread/start": wire.responses.threadStart,
};

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.method === undefined) return;
  record({ kind: "request", method: message.method });
  write({ id: message.id, result: results[message.method] ?? {} });
});
