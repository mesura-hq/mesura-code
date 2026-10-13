// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChatHeader } from "../chat/ChatHeader";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ENVIRONMENT,
  installWorkloadViewport,
  makeWorkloadHarness,
  OTHER_ENVIRONMENT,
  OTHER_THREAD,
  THREAD,
  type WorkloadHarness,
} from "../../state/workloads.testkit";
import { ThreadWorkloadsControl } from "./ThreadWorkloadsControl";

let harness: WorkloadHarness;
let viewport: ReturnType<typeof installWorkloadViewport>;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = installWorkloadViewport(false);
  harness = await makeWorkloadHarness();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  harness.dispose();
  viewport.restore();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function trigger() {
  return container.querySelector<HTMLButtonElement>("[data-thread-workloads-trigger]")!;
}
async function render(environmentId = ENVIRONMENT, threadId = THREAD) {
  await act(async () =>
    root.render(
      harness.provider(
        <ThreadWorkloadsControl environmentId={environmentId} threadId={threadId} />,
      ),
    ),
  );
}
async function open() {
  await act(async () => {
    trigger().focus();
    trigger().click();
  });
  await harness.read({ threadId: THREAD });
}

describe("thread workload surfaces", () => {
  it("opens the desktop popover with the exact environment/thread filter and releases polling on close", async () => {
    await render();
    expect(harness.calls.list).toHaveLength(0);
    await open();
    expect(harness.calls.list[0]).toEqual({
      environmentId: ENVIRONMENT,
      input: { threadId: THREAD },
    });
    expect(document.querySelector('[data-slot="popover-popup"]')!.textContent).toContain(
      "Assigned to this thread",
    );
    const close = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-popup"] button'),
    ].find((node) => node.textContent === "Close")!;
    await act(async () => close.click());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-workload-list]")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const count = harness.calls.list.length;
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    expect(harness.calls.list.length).toBe(count);
  });
  it.each(["button", "escape"] as const)(
    "opens a phone sheet and closes by %s without leaving workload polling",
    async (path) => {
      await act(async () => viewport.setMobile(true));
      await render();
      await open();
      expect(document.querySelector('[data-slot="sheet-popup"]')!.textContent).toContain(
        "Frontend preview",
      );
      await act(async () => {
        if (path === "button")
          document
            .querySelector<HTMLButtonElement>(
              '[data-slot="sheet-popup"] button[aria-label="Close"]',
            )!
            .click();
        else
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
          );
      });
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-workload-list]")).toBeNull();
    },
  );
  it.each([false, true])(
    "closes across colliding delimiter IDs before querying the new owner at mobile=%s",
    async (mobile) => {
      const firstEnvironment = EnvironmentId.make("a:b");
      const secondEnvironment = EnvironmentId.make("a");
      const firstThread = ThreadId.make("c");
      const secondThread = ThreadId.make("b:c");
      harness.dispose();
      harness = await makeWorkloadHarness([firstEnvironment, secondEnvironment]);
      await act(async () => viewport.setMobile(mobile));
      await render(firstEnvironment, firstThread);
      await act(async () => trigger().click());
      await harness.read({ threadId: firstThread }, firstEnvironment);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(harness.calls.list).toEqual([
        { environmentId: firstEnvironment, input: { threadId: firstThread } },
      ]);

      await render(secondEnvironment, secondThread);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-workload-list]")).toBeNull();
      expect(harness.calls.list).toHaveLength(1);
      await act(async () => trigger().click());
      await harness.read({ threadId: secondThread }, secondEnvironment);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(harness.calls.list).toEqual([
        { environmentId: firstEnvironment, input: { threadId: firstThread } },
        { environmentId: secondEnvironment, input: { threadId: secondThread } },
      ]);
      await render(firstEnvironment, firstThread);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-workload-list]")).toBeNull();
      expect(harness.calls.list).toHaveLength(2);
    },
  );
  it("closes when thread, environment or viewport changes and never carries the old owner's query", async () => {
    await render();
    await open();
    await render(ENVIRONMENT, OTHER_THREAD);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-workload-list]")).toBeNull();
    await act(async () => trigger().click());
    await harness.read({ threadId: OTHER_THREAD });
    await render(OTHER_ENVIRONMENT, OTHER_THREAD);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger().click());
    await harness.read({ threadId: OTHER_THREAD }, OTHER_ENVIRONMENT);
    await act(async () => viewport.setMobile(true));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-workload-list]")).toBeNull();
  });
});

it("mounts the real header trigger only for server threads and closes it when the header becomes a draft", async () => {
  let serverThread = false;
  const Header = () =>
    harness.provider(
      <ChatHeader
        activeThreadEnvironmentId={ENVIRONMENT}
        activeThreadId={THREAD}
        activeThreadTitle="Workload thread"
        isServerThread={serverThread}
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />,
    );
  const rootRoute = createRootRoute({ component: Header });
  const index = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  expect(container.querySelector("[data-thread-workloads-trigger]")).toBeNull();
  expect(harness.calls.list).toHaveLength(0);
  serverThread = true;
  await act(async () => root.render(<RouterProvider key="server" router={router} />));
  await open();
  expect(harness.calls.list[0]).toEqual({
    environmentId: ENVIRONMENT,
    input: { threadId: THREAD },
  });
  serverThread = false;
  await act(async () => root.render(<RouterProvider key="draft" router={router} />));
  expect(container.querySelector("[data-thread-workloads-trigger]")).toBeNull();
  expect(document.querySelector("[data-workload-list]")).toBeNull();
});
