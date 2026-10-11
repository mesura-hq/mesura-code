import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { AppRoot } from "../AppRoot";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import ChatView from "../components/ChatView";
import type { AppRouter } from "../router";
import { Route as ChatLayoutRoute } from "../routes/_chat";
import type { Thread } from "../types";
import { appRootFence, FENCE_ENVIRONMENT_ID, FENCE_PROJECT_ID } from "./appRootFenceMocks";

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

/** Registers a thread with `id`, `title` and `messages`, and returns its id. */
export function addFenceThread(
  id: string,
  title: string,
  messages: ReadonlyArray<ReturnType<typeof makeMessage>>,
): ThreadId {
  const threadId = ThreadId.make(id);
  appRootFence.threads.set(threadId, {
    id: threadId,
    environmentId: fenceEnvironmentId,
    projectId: ProjectId.make(FENCE_PROJECT_ID),
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages,
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
  } as unknown as Thread);
  return threadId;
}

/**
 * A memory router whose root renders the real CommandPalette around the real
 * AppSidebarLayout, as `routes/__root.tsx` does, and whose chat layout is the
 * real `_chat.tsx` route component. The thread route reads the environment
 * and thread ids from its params, as `routes/_chat.$environmentId.$threadId.tsx`
 * does, so opening another thread is a router navigation.
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
    component: function FixtureThreadRoute() {
      const params = thread.useParams();
      return (
        <ChatView
          environmentId={EnvironmentId.make(params.environmentId)}
          threadId={ThreadId.make(params.threadId)}
          routeKind="server"
        />
      );
    },
  });
  return createRouter({
    routeTree: route.addChildren([chatLayout.addChildren([thread])]),
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
): Promise<{ root: Root; router: FenceRouter }> {
  appRootFence.vimMode = vimMode;
  appRootFence.openThreadId = threadId;
  const router = createFenceRouter(threadId);
  await router.load();
  const root = createRoot(container);
  await act(async () => {
    root.render(<AppRoot router={router as unknown as AppRouter} />);
  });
  return { root, router };
}
