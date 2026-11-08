import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { registerPaneEntry } from "~/lib/paneFocus";

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: "about:blank",
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => "about:blank",
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("HtmlRenderFrame", () => {
  it("accepts exit only from the focused document and returns through the chat pane entry", async () => {
    await using screen = await render(
      <div data-chat-column>
        <button>Chat entry</button>
        <HtmlRenderFrame
          environmentId={EnvironmentId.make("environment")}
          htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
          threadRef={undefined}
        />
      </div>,
    );
    const chatEntry = screen
      .getByRole("button", { name: "Chat entry" })
      .element() as HTMLButtonElement;
    const enter = vi.fn(() => {
      chatEntry.focus();
      return true;
    });
    using _entry = { [Symbol.dispose]: registerPaneEntry("chat", enter) };
    using _activation = vi.spyOn(navigator, "userActivation", "get").mockReturnValue({
      isActive: false,
      hasBeenActive: false,
    });
    const frame = screen.container.querySelector("iframe")!;
    const exit = (source: Window | null) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: { jsonrpc: "2.0", method: "t3/notifications/exit" },
        }),
      );

    chatEntry.focus();
    exit(frame.contentWindow);
    expect(enter).not.toHaveBeenCalled();
    frame.focus();
    exit(window);
    expect(document.activeElement).toBe(frame);
    expect(enter).not.toHaveBeenCalled();
    exit(frame.contentWindow);
    expect(enter).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(chatEntry);
    expect(frame.hasAttribute("data-mesura-chat-object-entry")).toBe(true);
  });

  it("closes the full-screen dialog when its focused document exits", async () => {
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const dialog = screen.getByRole("dialog").element();
    const frame = dialog.querySelector("iframe")!;
    frame.focus();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", method: "t3/notifications/exit" },
      }),
    );
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Open full screen" })).toHaveFocus();
  });

  it("reports leaving full screen when it unmounts while expanded", async () => {
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(true);

    await screen.unmount();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });
});
