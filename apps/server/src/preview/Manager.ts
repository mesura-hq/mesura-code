/**
 * Sessions are keyed by `(threadId, tabId)`. `open` always creates a tab, because the
 * renderer owns tab lifecycle; only `openLinkTarget` reuses the thread-link tab, under
 * the same lock as open and close. Events go through a `PubSub`, so a closed WS
 * subscriber queue cannot fail an in-progress `navigate()`.
 */
import {
  type PreviewCloseInput,
  type PreviewEvent,
  type PreviewError,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewNavStatus,
  type PreviewOpenInput,
  type PreviewOpenLinkTargetInput,
  type PreviewOpenLinkTargetResult,
  type PreviewSessionPurpose,
  type PreviewRefreshInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  type PreviewAdjustInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  isPreviewUrlNormalizationError,
  newPreviewTabId,
  normalizePreviewUrl,
} from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { PreviewControlRequiredError } from "@t3tools/contracts";

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (
      input: PreviewOpenInput & {
        readonly automationOwner?: string;
        /** Runs before the `opened` event publishes, so subscribers find state keyed by the tab. */
        readonly beforePublish?: (snapshot: PreviewSessionSnapshot) => void;
      },
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly openLinkTarget: (
      input: PreviewOpenLinkTargetInput,
    ) => Effect.Effect<PreviewOpenLinkTargetResult>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (
      input: PreviewReportStatusInput & { readonly serverControlled?: boolean },
    ) => Effect.Effect<void, PreviewError>;
    readonly requestReveal: (
      input: PreviewCloseInput & { readonly tabId: string; readonly force: boolean },
    ) => Effect.Effect<void, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly adjust: (
      input: PreviewAdjustInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribeEvents: Effect.Effect<PubSub.Subscription<PreviewEvent>, never, Scope.Scope>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

interface ManagerState {
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
  readonly revision: number;
}

const initialState: ManagerState = { sessions: new Map(), revision: 0 };

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

const sessionsForThread = (
  state: ManagerState,
  threadId: string,
): ReadonlyArray<PreviewSessionState> => {
  const out: PreviewSessionState[] = [];
  for (const session of state.sessions.values()) {
    if (session.threadId === threadId) out.push(session);
  }
  return out;
};

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) => {
      if (isPreviewUrlNormalizationError(cause)) {
        return new PreviewInvalidUrlError({
          inputLength: cause.inputLength,
          reason: cause.reason,
          protocol: cause.protocol,
          cause,
        });
      }

      return new PreviewInvalidUrlError({
        inputLength: rawUrl.length,
        reason: "unexpected",
        cause,
      });
    },
  });

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** @public */
export const make = Effect.gen(function* PreviewManagerMake() {
  const crypto = yield* Crypto.Crypto;
  const serverEpoch = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  const eventsPubSub = yield* PubSub.unbounded<PreviewEvent>();
  const events: Stream.Stream<PreviewEvent> = Stream.fromPubSub(eventsPubSub);

  /** Publish inside the lock to preserve state-transition order. */
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (
      session: PreviewSessionState,
    ) => Effect.Effect<{ next: PreviewSessionState; emit: PreviewEventDraft | null; result: R }, E>,
  ): Effect.Effect<R, E | PreviewSessionLookupError> => {
    type ModifyResult =
      | { kind: "fail"; error: PreviewSessionLookupError }
      | { kind: "ok"; result: R };

    return SynchronizedRef.modifyEffect(stateRef, (state) => {
      const session = state.sessions.get(compositeKey(threadId, tabId));
      if (!session) {
        return Effect.succeed([
          { kind: "fail", error: new PreviewSessionLookupError({ threadId, tabId }) },
          state,
        ] as readonly [ModifyResult, ManagerState]);
      }
      return mutator(session).pipe(
        Effect.flatMap(
          Effect.fn("PreviewManager.commitMutation")(function* ({ next, emit, result }) {
            const revision = emit ? state.revision + 1 : state.revision;
            if (emit) {
              yield* PubSub.publish(eventsPubSub, {
                ...emit,
                revision,
                serverEpoch,
              } as PreviewEvent);
            }
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            return [{ kind: "ok", result } as ModifyResult, { sessions, revision }] as readonly [
              ModifyResult,
              ManagerState,
            ];
          }),
        ),
      );
    }).pipe(
      Effect.flatMap((modify) =>
        modify.kind === "fail" ? Effect.fail(modify.error) : Effect.succeed(modify.result),
      ),
    );
  };

  const createSnapshot = Effect.fn("PreviewManager.createSnapshot")(function* (
    input: PreviewOpenInput & { readonly automationOwner?: string },
    navStatus: PreviewNavStatus,
    purpose?: PreviewSessionPurpose,
  ) {
    const runtime = input.runtime;
    // Persisted client surfaces must not bind to a different tab after a server restart.
    const tabId = `${newPreviewTabId()}${runtime === "server" ? `_${serverEpoch}` : ""}`;
    const updatedAt = yield* currentIsoTimestamp;
    const snapshot: PreviewSessionSnapshot = {
      threadId: input.threadId,
      tabId,
      navStatus,
      canGoBack: false,
      canGoForward: false,
      viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(purpose === undefined ? {} : { purpose }),
      ...(runtime === "server" && input.automationOwner !== undefined
        ? { automationOwner: input.automationOwner }
        : {}),
      ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
      updatedAt,
    };
    return snapshot;
  });

  /** Both open paths publish while holding stateRef's lock, preserving event order. */
  const insertSession = Effect.fn("PreviewManager.insertSession")(function* (
    state: ManagerState,
    snapshot: PreviewSessionSnapshot,
    beforePublish?: (snapshot: PreviewSessionSnapshot) => void,
  ) {
    const revision = state.revision + 1;
    const sessions = new Map(state.sessions);
    sessions.set(compositeKey(snapshot.threadId, snapshot.tabId), {
      threadId: snapshot.threadId,
      tabId: snapshot.tabId,
      snapshot,
    });
    beforePublish?.(snapshot);
    yield* PubSub.publish(eventsPubSub, {
      type: "opened",
      threadId: snapshot.threadId,
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision,
      snapshot,
    });
    return { sessions, revision } satisfies ManagerState;
  });

  const listResult = (state: ManagerState, threadId: string): PreviewListResult => ({
    sessions: sessionsForThread(state, threadId)
      .map((session) => session.snapshot)
      .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    serverEpoch,
    revision: state.revision,
  });

  const open: PreviewManager["Service"]["open"] = Effect.fn("PreviewManager.open")(
    function* (input) {
      const navStatus: PreviewNavStatus = input.url
        ? { _tag: "Loading", url: yield* normalizeUrl(input.url), title: "" }
        : { _tag: "Idle" };
      const snapshot = yield* createSnapshot(input, navStatus);
      return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        insertSession(state, snapshot, input.beforePublish).pipe(
          Effect.map((next) => [snapshot, next] as const),
        ),
      );
    },
  );

  const openLinkTarget: PreviewManager["Service"]["openLinkTarget"] = Effect.fn(
    "PreviewManager.openLinkTarget",
  )(function* (input) {
    // Preparing a candidate is harmless; only the winner inserts it under the shared lock.
    const candidate = yield* createSnapshot(
      {
        threadId: input.threadId,
        profileId: input.profileId,
        viewport: input.viewport,
        runtime: "server",
      },
      { _tag: "Idle" },
      "thread-link",
    );
    return yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* () {
        const existing = sessionsForThread(state, input.threadId).find(
          ({ snapshot }) =>
            snapshot.purpose === "thread-link" &&
            snapshot.runtime === "server" &&
            snapshot.automationOwner === undefined,
        );
        if (existing) {
          return [
            { ...listResult(state, input.threadId), selectedTabId: existing.tabId },
            state,
          ] as const;
        }
        const next = yield* insertSession(state, candidate);
        return [
          { ...listResult(next, input.threadId), selectedTabId: candidate.tabId },
          next,
        ] as const;
      }),
    );
  });

  const navigate: PreviewManager["Service"]["navigate"] = Effect.fn("PreviewManager.navigate")(
    function* (input) {
      const url = yield* normalizeUrl(input.url);
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.navigateSession")(function* (session) {
          if (session.snapshot.runtime === "server")
            return yield* new PreviewControlRequiredError({ tabId: input.tabId });
          const updatedAt = yield* currentIsoTimestamp;
          const previousTitle =
            session.snapshot.navStatus._tag === "Idle" ? "" : session.snapshot.navStatus.title;
          const resolvedTitle = input.resolvedTitle ?? previousTitle;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            navStatus: { _tag: "Success", url, title: resolvedTitle },
            viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "navigated",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const reportStatus: PreviewManager["Service"]["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        if (session.snapshot.runtime === "server" && !input.serverControlled)
          return yield* new PreviewControlRequiredError({ tabId: input.tabId });
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          ...session.snapshot,
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
          updatedAt,
        };
        const emit: PreviewEventDraft =
          input.navStatus._tag === "LoadFailed"
            ? {
                type: "failed",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                url: input.navStatus.url,
                title: input.navStatus.title,
                code: input.navStatus.code,
                description: input.navStatus.description,
                ...(input.navStatus.download === undefined
                  ? {}
                  : { download: input.navStatus.download }),
              }
            : {
                type: "navigated",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                snapshot,
              };
        return {
          next: { ...session, snapshot },
          emit,
          result: undefined as void,
        };
      }),
    );
  });

  const resize: PreviewManager["Service"]["resize"] = Effect.fn("PreviewManager.resize")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.resizeSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            viewport: input.viewport,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const adjust: PreviewManager["Service"]["adjust"] = Effect.fn("PreviewManager.adjust")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.adjustSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            ...(input.colorScheme === undefined ? {} : { colorScheme: input.colorScheme }),
            ...(input.zoomFactor === undefined ? {} : { zoomFactor: input.zoomFactor }),
            updatedAt,
          };
          const request =
            input.hardReload || input.clear
              ? {
                  request: {
                    ...(input.hardReload ? { hardReload: true } : {}),
                    ...(input.clear ? { clear: input.clear } : {}),
                  },
                }
              : {};
          return {
            next: { ...session, snapshot },
            emit: {
              ...request,
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const refresh: PreviewManager["Service"]["refresh"] = Effect.fn("PreviewManager.refresh")(
    function* (input) {
      yield* mutateExistingSession(input.threadId, input.tabId, (session) =>
        Effect.succeed({ next: session, emit: null, result: undefined as void }),
      );
    },
  );

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const createdAt = yield* currentIsoTimestamp;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        const eventsToEmit: PreviewEvent[] = [];
        const sessions = new Map(state.sessions);
        const targets = input.tabId
          ? [state.sessions.get(compositeKey(input.threadId, input.tabId))].filter(
              (entry): entry is PreviewSessionState => entry !== undefined,
            )
          : sessionsForThread(state, input.threadId);
        let revision = state.revision;
        for (const target of targets) {
          revision += 1;
          sessions.delete(compositeKey(target.threadId, target.tabId));
          eventsToEmit.push({
            type: "closed",
            threadId: target.threadId,
            tabId: target.tabId,
            createdAt,
            serverEpoch,
            revision,
          });
        }
        if (eventsToEmit.length === 0) {
          return Effect.succeed([undefined, state] as const);
        }
        return Effect.as(
          Effect.forEach(eventsToEmit, (event) => PubSub.publish(eventsPubSub, event), {
            discard: true,
          }),
          [undefined, { sessions, revision }] as const,
        );
      });
    },
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state) => listResult(state, input.threadId)),
      );
    },
  );

  const requestReveal: PreviewManager["Service"]["requestReveal"] = Effect.fn(
    "PreviewManager.requestReveal",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.revealSession")(function* (session) {
        const snapshot = {
          ...session.snapshot,
          reveal: true,
          revealRequest: {
            id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            force: input.force,
          },
          updatedAt: yield* currentIsoTimestamp,
        };
        return {
          next: { ...session, snapshot },
          emit: {
            type: "navigated" as const,
            threadId: session.threadId,
            tabId: session.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          },
          result: undefined,
        };
      }),
    );
  });

  return PreviewManager.of({
    open,
    openLinkTarget,
    requestReveal,
    navigate,
    reportStatus,
    resize,
    adjust,
    refresh,
    close,
    list,
    events,
    subscribeEvents: PubSub.subscribe(eventsPubSub),
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
