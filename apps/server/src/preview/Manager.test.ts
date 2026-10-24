import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type PreviewEvent, ThreadId } from "@t3tools/contracts";
import { PreviewUrlNormalizationError } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "./Manager.ts";

const DRAIN_LIMIT = 100;

interface EventCollector {
  /** Drain everything published since the last call (or since subscribe). */
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/**
 * Each `it.effect` shares the live PreviewManager layer across the whole
 * `it.layer` block, so tests that assert per-thread counts must use a unique
 * thread id to avoid bleeding state from earlier tests.
 */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/**
 * Subscribe to the manager's event stream BEFORE the test publishes. We
 * use `subscribeEvents` (synchronous PubSub.subscribe under the hood) so
 * no event can land between subscribe and the consumer drain.
 */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

const layer = PreviewManager.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-manager-" })),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("PreviewManager", (it) => {
  it.effect(
    "thread-link allocation guard keeps ordinary open registration before publication",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const subscription = yield* manager.subscribeEvents;
        const registrations = new Map<string, string>();
        const opener = yield* manager
          .open({
            threadId,
            runtime: "server",
            automationOwner: "ordinary-agent",
            reveal: true,
            profileId: "work",
            url: "localhost:5173",
            beforePublish: (snapshot) => registrations.set(snapshot.tabId, "registered"),
          })
          .pipe(Effect.forkChild);
        const event = yield* PubSub.take(subscription);
        expect(registrations.get(event.tabId)).toBe("registered");
        const snapshot = yield* Fiber.join(opener);
        expect(snapshot).toMatchObject({
          automationOwner: "ordinary-agent",
          reveal: true,
          profileId: "work",
          navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
        });
        expect(snapshot).not.toHaveProperty("purpose");
        expect(event).toMatchObject({ type: "opened", snapshot });
      }),
  );

  it.effect(
    "thread-link allocator gives concurrent clients one Idle target and one opened event",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const collector = yield* collectEvents;
        const before = yield* manager.list({ threadId });
        const start = yield* Deferred.make<void>();
        const clients = yield* Effect.forEach(Array.from({ length: 12 }), () =>
          Deferred.await(start).pipe(
            Effect.andThen(manager.openLinkTarget({ threadId, profileId: "work" })),
            Effect.forkChild,
          ),
        );
        yield* Deferred.succeed(start, undefined);
        const allocations = yield* Effect.forEach(clients, Fiber.join);
        const listed = yield* manager.list({ threadId });
        expect(new Set(allocations.map((result) => result.selectedTabId)).size).toBe(1);
        expect(listed.sessions).toHaveLength(1);
        expect(listed.revision).toBe(before.revision + 1);
        expect(listed.sessions[0]).toMatchObject({
          tabId: allocations[0]?.selectedTabId,
          purpose: "thread-link",
          runtime: "server",
          profileId: "work",
          viewport: { _tag: "fill" },
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
        });
        expect(listed.sessions[0]).not.toHaveProperty("automationOwner");
        expect(listed.sessions[0]).not.toHaveProperty("reveal");
        for (const result of allocations) {
          expect(result).toEqual({ ...listed, selectedTabId: listed.sessions[0]?.tabId });
        }
        expect(yield* collector.drain).toEqual([
          expect.objectContaining({
            type: "opened",
            serverEpoch: listed.serverEpoch,
            revision: listed.revision,
            snapshot: listed.sessions[0],
          }),
        ]);
      }),
  );

  it.effect("thread-link allocator isolates threads and never adopts ordinary or agent tabs", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const otherThreadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const manual = yield* manager.open({ threadId, runtime: "server" });
      const desktop = yield* manager.open({ threadId });
      const agent = yield* manager.open({
        threadId,
        runtime: "server",
        automationOwner: "agent-session",
        reveal: true,
      });
      const result = yield* manager.openLinkTarget({ threadId });
      const other = yield* manager.openLinkTarget({ threadId: otherThreadId });
      expect(result.sessions).toHaveLength(4);
      expect(result.sessions).toEqual(expect.arrayContaining([manual, desktop, agent]));
      expect([manual.tabId, desktop.tabId, agent.tabId, other.selectedTabId]).not.toContain(
        result.selectedTabId,
      );
      expect(other.sessions).toHaveLength(1);
      expect(other.sessions[0]?.threadId).toBe(otherThreadId);
      for (const snapshot of [manual, desktop, agent]) {
        expect(snapshot).not.toHaveProperty("purpose");
      }
      const nextManual = yield* manager.open({ threadId, runtime: "server" });
      expect(nextManual.tabId).not.toBe(result.selectedTabId);
      expect(nextManual).not.toHaveProperty("purpose");
    }),
  );

  it.effect(
    "thread-link reuse preserves the full browser state and emits no navigation or reveal",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const initial = yield* manager.openLinkTarget({
          threadId,
          profileId: "work",
          viewport: { _tag: "freeform", width: 1024, height: 768 },
        });
        yield* manager.reportStatus({
          threadId,
          tabId: initial.selectedTabId,
          serverControlled: true,
          navStatus: { _tag: "Success", url: "https://example.com/history", title: "History" },
          canGoBack: true,
          canGoForward: true,
        });
        yield* manager.adjust({
          threadId,
          tabId: initial.selectedTabId,
          colorScheme: "dark",
          zoomFactor: 1.25,
        });
        const before = yield* manager.list({ threadId });
        const collector = yield* collectEvents;
        const reused = yield* manager.openLinkTarget({
          threadId,
          profileId: "personal",
          viewport: { _tag: "fill" },
        });
        expect(reused).toEqual({ ...before, selectedTabId: initial.selectedTabId });
        expect(yield* manager.list({ threadId })).toEqual(before);
        expect(yield* collector.drain).toEqual([]);
        expect(
          yield* manager
            .navigate({
              threadId,
              tabId: reused.selectedTabId,
              url: "https://example.com/forbidden",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PreviewControlRequiredError" });
        expect(
          yield* manager
            .reportStatus({
              threadId,
              tabId: reused.selectedTabId,
              navStatus: { _tag: "Idle" },
              canGoBack: false,
              canGoForward: false,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PreviewControlRequiredError" });
        expect(yield* manager.list({ threadId })).toEqual(before);
        expect(yield* collector.drain).toEqual([]);
      }),
  );

  it.effect(
    "thread-link close releases only the designated tab and reopen takes new defaults",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const first = yield* manager.openLinkTarget({ threadId, profileId: "work" });
        const manual = yield* manager.open({ threadId, runtime: "server" });
        yield* manager.close({ threadId, tabId: manual.tabId });
        expect((yield* manager.openLinkTarget({ threadId })).selectedTabId).toBe(
          first.selectedTabId,
        );
        const survivor = yield* manager.open({ threadId, runtime: "server" });
        const collector = yield* collectEvents;
        yield* manager.close({ threadId, tabId: first.selectedTabId });
        const reopened = yield* manager.openLinkTarget({ threadId, profileId: "personal" });
        expect(reopened.selectedTabId).not.toBe(first.selectedTabId);
        expect(reopened.sessions).toEqual([
          survivor,
          expect.objectContaining({
            tabId: reopened.selectedTabId,
            profileId: "personal",
            purpose: "thread-link",
            navStatus: { _tag: "Idle" },
          }),
        ]);
        const events = yield* collector.drain;
        expect(events.map((event) => event.type)).toEqual(["closed", "opened"]);
        expect(events[1]?.revision).toBe((events[0]?.revision ?? 0) + 1);
        expect(reopened.revision).toBe(events[1]?.revision);
        yield* manager.close({ threadId });
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
        expect((yield* manager.openLinkTarget({ threadId })).selectedTabId).not.toBe(
          reopened.selectedTabId,
        );
      }),
  );

  it.effect(
    "thread-link racing close and allocation returns a state consistent with published order",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const initial = yield* manager.openLinkTarget({ threadId });
        const collector = yield* collectEvents;
        const start = yield* Deferred.make<void>();
        const closer = yield* Deferred.await(start).pipe(
          Effect.andThen(manager.close({ threadId, tabId: initial.selectedTabId })),
          Effect.forkChild,
        );
        const allocator = yield* Deferred.await(start).pipe(
          Effect.andThen(manager.openLinkTarget({ threadId })),
          Effect.forkChild,
        );
        yield* Deferred.succeed(start, undefined);
        yield* Fiber.join(closer);
        const result = yield* Fiber.join(allocator);
        const events = yield* collector.drain;
        const listed = yield* manager.list({ threadId });
        if (result.selectedTabId === initial.selectedTabId) {
          expect(result).toEqual(initial);
          expect(events.map((event) => event.type)).toEqual(["closed"]);
          expect(listed.sessions).toEqual([]);
          expect(listed.revision).toBe(result.revision + 1);
        } else {
          expect(events.map((event) => event.type)).toEqual(["closed", "opened"]);
          expect(result).toEqual({ ...listed, selectedTabId: listed.sessions[0]?.tabId });
          expect(result.revision).toBe(initial.revision + 2);
        }
      }),
  );

  it.effect(
    "thread-link close publication is a milestone before allocation captures the replacement",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const initial = yield* manager.openLinkTarget({ threadId });
        const subscription = yield* manager.subscribeEvents;
        const closer = yield* manager.close({ threadId }).pipe(Effect.forkChild);
        const closed = yield* PubSub.take(subscription);
        const replacement = yield* manager.openLinkTarget({ threadId });
        yield* Fiber.join(closer);
        const opened = yield* PubSub.take(subscription);
        expect(closed).toMatchObject({ type: "closed", tabId: initial.selectedTabId });
        expect(opened).toMatchObject({
          type: "opened",
          tabId: replacement.selectedTabId,
          revision: closed.revision + 1,
        });
        expect(replacement.selectedTabId).not.toBe(initial.selectedTabId);
        expect(replacement).toEqual({
          ...(yield* manager.list({ threadId })),
          selectedTabId: replacement.selectedTabId,
        });
      }),
  );

  it.effect(
    "thread-link opened publication is a milestone before close removes the allocation",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const subscription = yield* manager.subscribeEvents;
        const allocator = yield* manager.openLinkTarget({ threadId }).pipe(Effect.forkChild);
        const opened = yield* PubSub.take(subscription);
        yield* manager.close({ threadId, tabId: opened.tabId });
        const result = yield* Fiber.join(allocator);
        const closed = yield* PubSub.take(subscription);
        expect(result.sessions).toHaveLength(1);
        expect(result.selectedTabId).toBe(opened.tabId);
        expect(result.revision).toBe(opened.revision);
        expect(closed).toMatchObject({
          type: "closed",
          tabId: result.selectedTabId,
          revision: result.revision + 1,
        });
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      }),
  );

  it.effect(
    "thread-link allocation resets its in-memory designation and epoch on manager restart",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const create = PreviewManager.make.pipe(Effect.provide(NodeCrypto.layer));
        const firstManager = yield* create;
        const first = yield* firstManager.openLinkTarget({ threadId });
        const restartedManager = yield* create;
        expect((yield* restartedManager.list({ threadId })).sessions).toEqual([]);
        const restarted = yield* restartedManager.openLinkTarget({ threadId });
        expect(restarted.serverEpoch).not.toBe(first.serverEpoch);
        expect(restarted.selectedTabId).not.toBe(first.selectedTabId);
        expect(restarted.selectedTabId.endsWith(`_${restarted.serverEpoch}`)).toBe(true);
        expect(restarted.revision).toBe(1);
      }),
  );

  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("keeps the tab's profile across navigation and status reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const opened = yield* manager.open({ threadId, profileId: "work" });
      expect(opened.profileId).toBe("work");

      // `navigate` and `reportStatus` rebuild the snapshot field by field
      // rather than spreading it, so a new field is dropped unless carried
      // explicitly — which would silently move the tab to another profile's
      // partition on its first navigation.
      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "localhost:5173",
      });
      expect(navigated.profileId).toBe("work");

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions.find((s) => s.tabId === opened.tabId)?.profileId).toBe("work");
    }),
  );

  it.effect("lets any client size, theme, and zoom a server tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, runtime: "server" });
      const viewport = {
        _tag: "preset",
        presetId: "iphone-12-pro",
        width: 390,
        height: 844,
      } as const;
      yield* manager.resize({ threadId, tabId: opened.tabId, viewport });
      const adjusted = yield* manager.adjust({
        threadId,
        tabId: opened.tabId,
        colorScheme: "dark",
        zoomFactor: 1.25,
      });
      expect(adjusted).toMatchObject({ viewport, colorScheme: "dark", zoomFactor: 1.25 });
      // One-off requests go to the server's browser and leave the tab's state alone.
      yield* manager.adjust({ threadId, tabId: opened.tabId, hardReload: true, clear: "cache" });
      const events = (yield* collector.drain).filter((event) => event.type === "resized");
      expect(events.at(-1)).toMatchObject({
        request: { hardReload: true, clear: "cache" },
        snapshot: { colorScheme: "dark", zoomFactor: 1.25 },
      });
      expect(events.at(-2)).not.toHaveProperty("request");
    }),
  );

  it.effect("reissues presentation requests without replaying them on navigation", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: true });
      const first = (yield* manager.list({ threadId })).sessions[0];
      expect(first?.reveal).toBe(true);
      expect(first?.revealRequest?.force).toBe(true);
      // Server tabs report navigation through their controlling browser.
      const refused = yield* manager
        .navigate({ threadId, tabId: opened.tabId, url: "localhost:5173" })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("PreviewControlRequiredError");
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: false,
        canGoForward: false,
      });
      expect((yield* manager.list({ threadId })).sessions[0]?.revealRequest).toEqual(
        first?.revealRequest,
      );
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: false });
      const second = (yield* manager.list({ threadId })).sessions[0];
      expect(second?.revealRequest?.id).not.toBe(first?.revealRequest?.id);
      expect(second?.revealRequest?.force).toBe(false);
      const events = yield* collector.drain;
      const last = events.at(-1);
      expect(last?.type).toBe("navigated");
      if (last?.type === "navigated")
        expect(last.snapshot.revealRequest).toEqual(second?.revealRequest);
    }),
  );

  it.effect("opens an Idle tab when no URL is supplied", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId });
      expect(snapshot.navStatus._tag).toBe("Idle");
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/ready",
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("treats bare hosts as https", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId, url: "example.com" });
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("https://example.com/");
      }
    }),
  );

  it.effect("rejects empty URL with PreviewInvalidUrlError", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(manager.open({ threadId, url: "   " }));
      expect(error._tag).toBe("PreviewInvalidUrlError");
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect(error.cause).toBeInstanceOf(PreviewUrlNormalizationError);
      expect((error.cause as PreviewUrlNormalizationError).reason).toBe("empty");
    }),
  );

  it.effect("preserves URL parser failures as the invalid URL cause chain", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
      const error = yield* Effect.flip(manager.open({ threadId, url: rawUrl }));

      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect(error.cause).toBeInstanceOf(PreviewUrlNormalizationError);
      const normalizationError = error.cause as PreviewUrlNormalizationError;
      expect(normalizationError.cause).toBeInstanceOf(Error);
      expect(error.message).not.toContain((normalizationError.cause as Error).message);
      expect(error.message).not.toMatch(/user|password|access_token|secret|fragment/);
    }),
  );

  it.effect("navigate updates snapshot and emits navigated", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const snapshot = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/about",
        resolvedTitle: "About",
      });

      expect(snapshot.navStatus._tag).toBe("Success");
      if (snapshot.navStatus._tag === "Success") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/about");
        expect(snapshot.navStatus.title).toBe("About");
      }
      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "navigated"]);
    }),
  );

  it.effect("navigate fails for unknown tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.navigate({
          threadId,
          tabId: "tab_missing",
          url: "http://localhost:5173",
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({ _tag: "freeform", width: 1024, height: 768 });

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/resized",
      });
      expect(navigated.viewport).toEqual(resized.viewport);

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/resized", title: "Resized" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual([
        "opened",
        "resized",
        "navigated",
        "navigated",
      ]);
    }),
  );

  it.effect("rejects resize for an unknown tab", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.resize({
          threadId: freshThreadId(),
          tabId: "tab_missing",
          viewport: { _tag: "fill" },
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect(
    "rejects client status reports for server tabs without changing state or emitting events",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
        const collector = yield* collectEvents;
        const before = yield* manager.list({ threadId });
        const input = {
          threadId,
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success" as const,
            url: "http://localhost:5173/changed",
            title: "Changed",
          },
          canGoBack: true,
          canGoForward: true,
        };
        const rejected = yield* manager.reportStatus(input).pipe(Effect.flip);
        expect(rejected._tag).toBe("PreviewControlRequiredError");
        expect(yield* manager.list({ threadId })).toEqual(before);
        expect(yield* collector.drain).toEqual([]);

        yield* manager.reportStatus({ ...input, serverControlled: true });
        expect((yield* manager.list({ threadId })).sessions[0]).toMatchObject({
          navStatus: input.navStatus,
          canGoBack: true,
          canGoForward: true,
        });
        const events = yield* collector.drain;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "navigated",
          snapshot: { navStatus: input.navStatus },
        });
      }),
  );

  it.effect("reportStatus emits failed for LoadFailed nav", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: {
          _tag: "LoadFailed",
          url: "http://localhost:5173",
          title: "",
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
        canGoBack: false,
        canGoForward: false,
      });

      const events = yield* collector.drain;
      const failed = events.find((e) => e.type === "failed");
      expect(failed?.type).toBe("failed");
      if (failed?.type === "failed") {
        expect(failed.code).toBe(-105);
        expect(failed.description).toBe("ERR_NAME_NOT_RESOLVED");
      }
    }),
  );

  it.effect("close removes the session and emits closed", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId });

      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
      const events = yield* collector.drain;
      const closed = events.find((e) => e.type === "closed");
      expect(closed?.type).toBe("closed");
    }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "closed")).toBe(true);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(0);
    }),
  );

  it.effect("close is idempotent for unknown threads", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.close({ threadId });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
    }),
  );

  it.effect("list returns every snapshot for the thread sorted by updatedAt", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const first = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const second = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(2);
      const ids = result.sessions.map((s) => s.tabId);
      expect(ids).toContain(first.tabId);
      expect(ids).toContain(second.tabId);
    }),
  );

  it.effect("open creates an independent tab on every call", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000/path" });

      expect(a.tabId).not.toBe(b.tabId);
      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(2);

      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );

  it.effect("close with mismatching tabId is a no-op", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId, tabId: "tab_missing" });

      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(1);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );

  it.effect("multiple subscribers receive every event independently", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const aSub = yield* manager.subscribeEvents;
      const bSub = yield* manager.subscribeEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });

      const aEvents = yield* PubSub.takeUpTo(aSub, DRAIN_LIMIT);
      const bEvents = yield* PubSub.takeUpTo(bSub, DRAIN_LIMIT);
      expect(aEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
      expect(bEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );
});
