import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
const testState = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock(import("@effect/atom-react"), async (original) => ({ ...(await original()), useAtomValue: (() => AsyncResult.success({ authenticated: true, scopes: ["environment:maintain"] })) as never }));
vi.mock(import("~/state/use-atom-command"), async (original) => ({ ...(await original()), useAtomCommand: (() => testState.update) as never }));
vi.mock(import("~/hooks/useSettings"), async (original) => ({ ...(await original()), useEnvironmentSettings: ((_id: unknown, select: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown) => select({ continueThreadsAfterServerUpdate: false })) as never }));
import { ServerUpdateAction, ServerUpdateProgress } from "./ServerUpdateAction";

describe("Mesura update safety", () => {
  it("offers no replacement package command when Mesura publishes no server package", async () => {
    await using screen = await render(<ServerUpdateAction environmentId={EnvironmentId.make("manual")} serverLabel="Remote" selfUpdate={null} targetVersion="0.0.31" />);
    expect(screen.container.querySelector("button")).toBeNull();
    expect(screen.container.textContent).not.toContain("npx t3");
  });
  it("keeps the restart wait visible and folds installation into downloading", async () => {
    await using screen = await render(<ServerUpdateProgress state={{ status: "running", fromVersion: "0.0.30", stage: "resuming", targetVersion: "0.0.31" }} />);
    expect(screen.container.textContent).toContain("Restarting");
    await screen.rerender(<ServerUpdateProgress state={{ status: "running", fromVersion: "0.0.30", stage: "installing", targetVersion: "0.0.31" }} />);
    expect(screen.container.textContent).toContain("Downloading");
  });
});
