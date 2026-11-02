import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { KeyEngineHost } from "./KeyEngineHost";
import { isFlashActive, startFlash } from "./flashSession";

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { vimMode: boolean }) => unknown) =>
    selector({ vimMode: true }),
}));

it("ends flash before navigating to a new route location", async () => {
  await using screen = await render(
    <main data-slot="sidebar-inset">
      <div data-chat-column-maximized-away="false">
        <KeyEngineHost />
      </div>
    </main>,
  );
  await act(() =>
    startFlash({
      scope: "chat",
      backdrop: () => [],
      collect: () => [],
      jump: () => {},
    }),
  );
  expect(isFlashActive("chat")).toBe(true);
  await act(() => screen.router!.navigate({ to: "/", search: { flash: "next" } }));
  expect(isFlashActive()).toBe(false);
});
