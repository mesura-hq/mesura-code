import { SymmetriaDictationSession } from "@symmetria/broker-contract";
import * as Schema from "effect/Schema";
import { assert, it } from "vite-plus/test";

import { shouldResumeConfirmation } from "./useDictationBridge";

const decodeSession = Schema.decodeUnknownSync(SymmetriaDictationSession);
const session = decodeSession({
  protocolVersion: { major: 1, minor: 5 },
  sessionId: "session-a",
  target: { kind: "thread", environmentId: "environment-a", threadId: "thread-a" },
  source: "shell",
  phase: "confirming",
  mode: "submit",
  projectName: "Project A",
  startedAt: "2026-08-29T12:00:00.000Z",
  elapsedMs: 17_000,
  audioLevel: null,
  graceRemainingMs: null,
  presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
});

it("waits for the ordered confirming frame before resuming confirmation", () => {
  assert.isFalse(shouldResumeConfirmation({ ...session, phase: "delivering" }, session));
  assert.isTrue(shouldResumeConfirmation(session, session));
});

it("rejects stale recovery from another session", () => {
  assert.isFalse(
    shouldResumeConfirmation(session, decodeSession({ ...session, sessionId: "session-b" })),
  );
});
