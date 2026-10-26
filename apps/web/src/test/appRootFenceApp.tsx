import "../index.css";
import "../mesura.css";

import { render as renderBrowser, type Screen } from "../../test/render";
import { focusTestWindow } from "./windowFocus";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";

import type { AppRouter } from "../router";
import { AppRoot } from "../AppRoot";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { Route as ChatLayoutRoute } from "../routes/_chat";
import {
  appRootFence,
  FENCE_ENVIRONMENT_ID,
  FENCE_PROJECT_ID,
  installFenceFontEvents,
} from "./appRootFenceMocks";
import { makeFenceThreadProjection, makeFenceThreadShell } from "./fenceThreadShell";

/**
 * Mounting the real app over `appRootFenceMocks.tsx`. Import it statically
 * from a fence that wires up those mocks: it loads the app, which must find
 * every mock in place.
 */

export const fenceEnvironmentId = EnvironmentId.make(FENCE_ENVIRONMENT_ID);
const now = "2026-10-08T12:00:00.000Z";

export function makeMessage(id: string, role: "user" | "assistant", text: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Registers a v2 shell and detail with local message turn items, and returns its id.
 * `options` places it in another project or overrides shell fields such as its run status.
 */
export function addFenceThread(
  id: string,
  title: string,
  messages: ReadonlyArray<ReturnType<typeof makeMessage>>,
  options: {
    readonly projectId?: string;
    readonly createdAt?: string;
    readonly overrides?: Partial<OrchestrationV2ThreadShell>;
  } = {},
): ThreadId {
  const threadId = ThreadId.make(id);
  const shell = makeFenceThreadShell({
    id: threadId,
    environmentId: fenceEnvironmentId,
    projectId: ProjectId.make(options.projectId ?? FENCE_PROJECT_ID),
    title,
    createdAt: options.createdAt ?? now,
    overrides: {
      itemCount: messages.length,
      visibleItemCount: messages.length,
      ...options.overrides,
    },
  });
  const conversationMessages = messages.map((message): OrchestrationV2ConversationMessage => ({
    id: message.id,
    threadId,
    runId: null,
    nodeId: null,
    role: message.role,
    text: message.text,
    attachments: [],
    streaming: message.streaming,
    createdBy: message.role === "user" ? "user" : "agent",
    creationSource: "web",
    createdAt: DateTime.makeUnsafe(message.createdAt),
    updatedAt: DateTime.makeUnsafe(message.updatedAt),
  }));
  const turnItems = conversationMessages.map((message, ordinal): OrchestrationV2TurnItem => {
    const base = {
      id: TurnItemId.make(`message:${message.id}`),
      threadId,
      runId: message.runId,
      nodeId: message.nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: message.createdAt,
      completedAt: message.updatedAt,
      updatedAt: message.updatedAt,
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
    };
    return message.role === "user"
      ? {
          ...base,
          type: "user_message",
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          inputIntent: "turn_start",
        }
      : { ...base, type: "assistant_message", streaming: message.streaming };
  });
  const projection = makeFenceThreadProjection(shell, {
    messages: conversationMessages,
    turnItems,
    visibleTurnItems: turnItems.map((item, position) => ({
      item,
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
    })),
  });
  publishFenceThreadProjection(projection);
  return threadId;
}

/**
 * Mirrors `routes/__root.tsx` and the real `_chat.tsx` layout. The leaf route renders nothing, as
 * the real thread route does, so navigation keeps one ChatView mounted across thread changes.
 */
export function createFenceRouter(firstThreadId: ThreadId) {
  const route = createRootRoute({
    component: () => (
      <CommandPalette>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </CommandPalette>
    ),
  });
  const chatLayout = createRoute({
    getParentRoute: () => route,
    id: "_chat",
    component: ChatLayoutRoute.options.component!,
  });
  const thread = createRoute({
    getParentRoute: () => chatLayout,
    path: "/$environmentId/$threadId",
    component: () => null,
  });
  // A Settings page outside the chat layout, as the real one is: the layout's
  // sidebar slot shows the settings navigation there.
  const settings = createRoute({
    getParentRoute: () => route,
    path: "/settings",
    component: () => <button data-testid="settings-control">Save</button>,
  });
  return createRouter({
    routeTree: route.addChildren([chatLayout.addChildren([thread]), settings]),
    history: createMemoryHistory({
      initialEntries: [`/${fenceEnvironmentId}/${firstThreadId}`],
    }),
  });
}

export type FenceRouter = ReturnType<typeof createFenceRouter>;

/**
 * Renders AppRoot on `threadId` into `container`, with Vim mode as given.
 * The caller settles the app afterwards, on its own clock.
 */
export async function renderFenceApp(
  container: HTMLElement,
  threadId: ThreadId,
  { vimMode }: { vimMode: boolean },
): Promise<{ root: Screen; router: FenceRouter }> {
  // The shared browser fixture lasts for this test environment, as document does.
  installFenceFontEvents();
  await focusTestWindow();
  appRootFence.vimMode = vimMode;
  appRootFence.openThreadId = threadId;
  const router = createFenceRouter(threadId);
  await router.load();
  // AppRoot owns this fixture's memory router.
  const root = await renderBrowser(<AppRoot router={router as unknown as AppRouter} />, {
    container,
    router: false,
  });
  return { root, router };
}

/** Publishes a detail projection and its corresponding shell through both fixture sources. */
export function publishFenceThreadProjection(
  projection: OrchestrationV2ThreadProjection,
  environmentId = fenceEnvironmentId,
) {
  const threadId = projection.thread.id;
  // Detail threads omit shell summary fields. The shared shell fixture supplies
  // those defaults and preserves the projection's supplied metadata and summaries.
  appRootFence.threads.set(
    threadId,
    makeFenceThreadShell({
      environmentId,
      id: threadId,
      projectId: projection.thread.projectId,
      overrides: projection.thread,
    }),
  );
  appRootFence.threadStates.set(threadId, {
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(projection),
  });
  for (const listener of appRootFence.threadListeners) listener();
}
