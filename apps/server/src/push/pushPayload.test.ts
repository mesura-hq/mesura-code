/**
 * Phase 3 fence of phone push notifications: acceptance criterion 5, the
 * notification a thread's awareness state turns into.
 *
 * Entry point: `buildPushPayload` (`pushPayload.ts`), the pure function the
 * dispatcher calls for every push it sends. `PushDispatcher.test.ts` checks
 * that the payload a device receives is this one.
 *
 * The URL is the web router's thread route, `/<environmentId>/<threadId>`,
 * each segment URL-encoded: the form `threadRoutePath` writes and
 * `parseNotificationTargetPath` reads in `apps/web/src/pushNotifications/`.
 * It is not `projectThreadAwarenessV2`'s `deepLink`, whose `/threads/` prefix
 * the web router does not serve.
 */
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { assert, describe, it } from "@effect/vitest";

import { buildPushPayload } from "./pushPayload.ts";

const ENVIRONMENT_ID = EnvironmentId.make("vigilia home/ä");
const THREAD_ID = ThreadId.make("thread:42?x#y");

const state = (
  phase: AgentAwarenessPhase,
  overrides: Partial<AgentAwarenessState> = {},
): AgentAwarenessState => ({
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  projectTitle: "Mesura Code",
  threadTitle: "Fix the flaky scan test",
  phase,
  headline: "Headline the relay shows",
  detail: "Detail the relay shows",
  modelTitle: "gpt-5.4",
  updatedAt: "2026-10-26T00:00:00.000Z",
  deepLink: "/threads/should-not-be-used",
  ...overrides,
});

/** What `parseNotificationTargetPath` in the web app does with the path. */
const threadRouteSegments = (url: string) => {
  const parsed = new URL(url, "https://notification-target.invalid");
  return {
    search: parsed.search,
    segments: parsed.pathname
      .split("/")
      .slice(1)
      .map((segment) => decodeURIComponent(segment)),
  };
};

describe("push phase 3 payload fence", () => {
  it.each([
    ["waiting_for_approval", "needs your approval"],
    ["waiting_for_input", "is asking you a question"],
    ["failed", "failed"],
    ["completed", "finished"],
  ] as const)(
    "push phase 3 AC5: a %s thread reads as the project, then the thread title and the reason line",
    (phase, reason) => {
      const payload = buildPushPayload(state(phase));
      assert.strictEqual(payload.title, "Mesura Code");
      assert.strictEqual(payload.body, `Fix the flaky scan test\n${reason}`);
    },
  );

  it("push phase 3 AC5: the tag names the environment and the thread, so a newer push replaces it", () => {
    const payload = buildPushPayload(state("waiting_for_approval"));
    assert.strictEqual(payload.tag, `thread:${ENVIRONMENT_ID}:${THREAD_ID}`);
    assert.strictEqual(
      buildPushPayload(state("failed")).tag,
      payload.tag,
      "every phase of one thread shares the tag",
    );
    assert.notStrictEqual(
      buildPushPayload(state("failed", { threadId: ThreadId.make("other-thread") })).tag,
      payload.tag,
    );
  });

  it("push phase 3 AC5: the URL is the URL-encoded web thread route, not the relay deep link", () => {
    const payload = buildPushPayload(state("waiting_for_input"));
    assert.strictEqual(
      payload.url,
      `/${encodeURIComponent(ENVIRONMENT_ID)}/${encodeURIComponent(THREAD_ID)}`,
    );
    assert.deepStrictEqual(threadRouteSegments(payload.url), {
      search: "",
      segments: [ENVIRONMENT_ID, THREAD_ID],
    });
  });

  it("push phase 3 AC5: the payload holds only title, body, tag and url, with no relay headline, detail or model", () => {
    const payload = buildPushPayload(state("failed", { detail: "The agent run failed." }));
    assert.deepStrictEqual(Object.keys(payload).toSorted(), ["body", "tag", "title", "url"]);
    const serialized = JSON.stringify(payload);
    for (const leaked of ["Headline the relay shows", "The agent run failed.", "gpt-5.4"]) {
      assert.notInclude(serialized, leaked);
    }
  });
});
