import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { notificationTargetPath, parseNotificationTargetPath } from "./notificationTarget";
import { deviceLabel } from "./pushRegistration";

/**
 * The path a worker notification carries is the only link between the page
 * that showed it and the window that opens it, so it must survive the round
 * trip for any thread id.
 */
describe("notification target paths", () => {
  it.each([
    { environmentId: "vigilia-home", threadId: "thread-1", agentSearch: false },
    { environmentId: "env with space", threadId: "thread/with?odd#chars", agentSearch: false },
    { environmentId: "vigilia-home", threadId: "search-1", agentSearch: true },
  ])("notification target regression: $threadId round-trips through its path", (raw) => {
    const target = {
      environmentId: EnvironmentId.make(raw.environmentId),
      threadId: ThreadId.make(raw.threadId),
      agentSearch: raw.agentSearch,
    };

    expect(parseNotificationTargetPath(notificationTargetPath(target))).toEqual(target);
  });

  it("notification target regression: the server's plain thread route opens the thread, not a search", () => {
    expect(parseNotificationTargetPath("/vigilia-home/thread-1")).toEqual({
      environmentId: EnvironmentId.make("vigilia-home"),
      threadId: ThreadId.make("thread-1"),
      agentSearch: false,
    });
  });

  it.each(["/", "/only-one", "/a/b/c", "//evil.example/x", "/%E0%A4%A/thread"])(
    "notification target regression: %s is not a thread target",
    (path) => {
      expect(parseNotificationTargetPath(path)).toBeNull();
    },
  );
});

describe("push device label", () => {
  it.each([
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Edge on Windows",
    ],
  ])("push device label regression: names the browser and system of %s", (userAgent, label) => {
    expect(deviceLabel(userAgent)).toBe(label);
  });
});
