/**
 * Mesura: the WebSocket RPC handlers for the fork's own RPCs.
 *
 * They are served by the same RPC server as upstream's (`ws.ts`), but their
 * handler layer is built here, over `WsRpcGroupMesura`. One handler layer over
 * every RPC exceeds TypeScript's instantiation depth (see `WsRpcGroupMesura`
 * in `packages/contracts/src/rpc.ts`), and a separate file keeps the fork's
 * handlers out of upstream's `ws.ts`, which conflicts at every sync.
 */
import {
  OrchestrationSearchThreadsError,
  ProjectReadFileError,
  THREAD_SEARCH_WS_METHODS,
  WS_METHODS,
  WsRpcGroupMesura,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { DictationJobs } from "./dictation/DictationJobs.ts";
import * as EditorSessionManager from "./editor/Manager.ts";
import * as FactoryRunTracker from "./factory/FactoryRunTracker.ts";
import * as FactorySnapshotStore from "./factory/FactorySnapshotStore.ts";
import * as FileManagerHost from "./fileManager/FileManagerHost.ts";
import { HostStatsService } from "./hostStats/HostStatsService.ts";
import * as GitHubIssueCli from "./issues/GitHubIssueCli.ts";
import { listIssues, readIssueDetail, resolveIssueReference } from "./issues/readIssues.ts";
import * as ThreadSearchBroker from "./mcp/ThreadSearchBroker.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ThreadSearchEvidence from "./orchestration-v2/ThreadSearchEvidence.ts";
import { ProjectIconDiscovery } from "./project/ProjectIconDiscovery.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as StartThreadSearchChat from "./textGeneration/StartThreadSearchChat.ts";
import { makeReasonThreadSearch } from "./textGeneration/ThreadSearchReasoning.ts";
import { AccountLimitsService } from "./usage/AccountLimitsService.ts";
import * as WorkspaceFileWatcher from "./workspace/WorkspaceFileWatcher.ts";
import { projectFileFailureContext } from "./ws.ts";

/**
 * The fork's services that every WebSocket connection shares, built once at
 * server scope (server.ts) and handed to each connection's handler layer by
 * `captureMesuraServerScope` (ws.ts).
 */
export const layerMesuraServerScope = Layer.mergeAll(
  ThreadSearchBroker.layer,
  StartThreadSearchChat.layer,
);

/** The server-scope instances, as a layer to provide to one connection's handlers. */
export const captureMesuraServerScope = Effect.gen(function* () {
  const broker = yield* ThreadSearchBroker.ThreadSearchBroker;
  const starter = yield* StartThreadSearchChat.StartThreadSearchChat;
  return Layer.mergeAll(
    Layer.succeed(ThreadSearchBroker.ThreadSearchBroker, broker),
    Layer.succeed(StartThreadSearchChat.StartThreadSearchChat, starter),
  );
});

// Same order as ws.ts: instrumentation wraps authorization.
const ServerWsRpcGroupMesura = WsRpcGroupMesura.middleware(RpcInstrumentation);

export const layerWsRpcMesura = ServerWsRpcGroupMesura.toLayer(
  Effect.gen(function* () {
    const threadSearchEvidence = yield* ThreadSearchEvidence.ThreadSearchEvidence;
    const reasonThreadSearch = yield* makeReasonThreadSearch;
    const startThreadSearchChat = yield* StartThreadSearchChat.StartThreadSearchChat;
    const threadSearchBroker = yield* ThreadSearchBroker.ThreadSearchBroker;
    // This layer is built once per WebSocket. Every connection's RPC protocol
    // numbers its client 0, so the broker tells connections apart by this id.
    const connectionIdentity = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
    const projectIconDiscovery = yield* ProjectIconDiscovery;
    const editorSessionManager = yield* EditorSessionManager.EditorSessionManager;
    const workspaceFileWatcher = yield* WorkspaceFileWatcher.WorkspaceFileWatcher;
    const fileManagerHost = yield* FileManagerHost.FileManagerHost;
    const factorySnapshots = yield* FactorySnapshotStore.FactorySnapshotStore;
    const factoryRunTracker = yield* FactoryRunTracker.FactoryRunTracker;
    const dictationJobs = yield* DictationJobs;
    const hostStats = yield* HostStatsService;
    const accountLimits = yield* AccountLimitsService;
    const review = yield* ReviewService.ReviewService;

    return ServerWsRpcGroupMesura.of({
      // Agent thread search reads (threadSearchEvidence.ts contracts) and one
      // bounded reasoning step on this environment's configured text model.
      [THREAD_SEARCH_WS_METHODS.listThreadSearchCatalog]: (input) =>
        threadSearchEvidence.listThreadSearchCatalog(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationSearchThreadsError({
                message: "Failed to list thread search catalog",
                cause,
              }),
          ),
        ),
      [THREAD_SEARCH_WS_METHODS.searchThreadEvidence]: (input) =>
        threadSearchEvidence.searchThreadEvidence(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationSearchThreadsError({
                message: "Failed to search thread evidence",
                cause,
              }),
          ),
        ),
      [THREAD_SEARCH_WS_METHODS.reasonThreadSearch]: (input) => reasonThreadSearch(input),

      // Search conversations (ADR-010). A client keeps the tool connection open
      // to answer the `find_threads` calls the broker forwards; a response is
      // accepted only from the connection the request went to.
      [THREAD_SEARCH_WS_METHODS.startThreadSearchChat]: () => startThreadSearchChat.start(),
      [THREAD_SEARCH_WS_METHODS.threadSearchToolConnect]: () =>
        Stream.unwrap(threadSearchBroker.connect(connectionIdentity)),
      [THREAD_SEARCH_WS_METHODS.threadSearchToolRespond]: (input) =>
        threadSearchBroker.respond(connectionIdentity, input),

      [WS_METHODS.serverGetAccountLimits]: (_input) => accountLimits.readSummary(),

      [WS_METHODS.issuesList]: (input) =>
        listIssues(input).pipe(Effect.provide(GitHubIssueCli.layer)),
      [WS_METHODS.issuesDetail]: (input) =>
        readIssueDetail(input).pipe(Effect.provide(GitHubIssueCli.layer)),
      [WS_METHODS.issuesResolveReference]: (input) =>
        resolveIssueReference(input).pipe(Effect.provide(GitHubIssueCli.layer)),

      // Server-side dictation. `start` returns once the job is tracked; the
      // transcription and its outcome arrive on the subscription.
      [WS_METHODS.dictationStart]: (input) => dictationJobs.start(input),
      [WS_METHODS.dictationRetry]: (input) => dictationJobs.retry(input.jobId),
      [WS_METHODS.dictationCancel]: (input) =>
        dictationJobs.cancel(input.jobId).pipe(Effect.map((applied) => ({ applied }))),
      [WS_METHODS.dictationSetMode]: (input) => dictationJobs.setMode(input.jobId, input.mode),
      [WS_METHODS.subscribeDictationJobs]: () => dictationJobs.stream,

      [WS_METHODS.projectIconsPreview]: (input) => projectIconDiscovery.preview(input.projectIds),
      [WS_METHODS.projectIconsDiscover]: (input) => projectIconDiscovery.discover(input),

      // The Symmetria file manager's bridge. A session belongs to the
      // connection that opened it, so every call carries the RPC client id
      // beside the client's own id.
      [WS_METHODS.fileManagerHost]: () => fileManagerHost.host,
      [WS_METHODS.fileManagerQuery]: (input, metadata) =>
        fileManagerHost.query(String(metadata.client.id), input),
      [WS_METHODS.fileManagerMutate]: (input, metadata) =>
        fileManagerHost.mutate(String(metadata.client.id), input),
      [WS_METHODS.fileManagerSubscribeEvents]: (input, metadata) =>
        fileManagerHost.events(String(metadata.client.id), input),

      [WS_METHODS.subscribeProjectFile]: (input) =>
        workspaceFileWatcher.watchFile(input).pipe(
          Stream.mapError(
            (cause) =>
              new ProjectReadFileError({
                ...input,
                ...projectFileFailureContext(cause),
                cause,
              }),
          ),
        ),

      [WS_METHODS.factoryReadSnapshot]: (input) =>
        factorySnapshots.read(input.digest).pipe(
          Effect.map((bytes) => ({
            digest: input.digest,
            markdown: new TextDecoder().decode(bytes),
          })),
        ),
      [WS_METHODS.subscribeFactoryRun]: (input) =>
        FactoryRunTracker.subscribeFactoryRun(factoryRunTracker, input),

      [WS_METHODS.reviewGetWorkingTreeChanges]: (input) => review.getWorkingTreeChanges(input),
      [WS_METHODS.reviewSubscribeWorkingTreeChanges]: (input) =>
        review.subscribeWorkingTreeChanges(input),

      // One editor session per thread: a whole Neovim, whose registers, marks
      // and undo survive moving between files in one piece of work.
      [WS_METHODS.editorSessionOpen]: (input) => editorSessionManager.open(input),
      [WS_METHODS.editorSessionAttach]: (input) =>
        EditorSessionManager.attachEventStream(editorSessionManager, input),
      [WS_METHODS.editorSessionInput]: (input) => editorSessionManager.input(input),
      [WS_METHODS.editorSessionViewport]: (input) => editorSessionManager.viewport(input),
      [WS_METHODS.editorSessionSetCursor]: (input) => editorSessionManager.setCursor(input),
      [WS_METHODS.editorSessionReplaceText]: (input) => editorSessionManager.replaceText(input),
      [WS_METHODS.editorSessionClose]: (input) => editorSessionManager.close(input),

      // The hosts dock. The snapshot first, then one message per sample.
      [WS_METHODS.subscribeHostStats]: (_input) =>
        Stream.unwrap(
          Effect.map(hostStats.subscribe, ({ latest, changes }) =>
            Stream.concat(Stream.make(latest), changes),
          ),
        ),
    });
  }),
);
