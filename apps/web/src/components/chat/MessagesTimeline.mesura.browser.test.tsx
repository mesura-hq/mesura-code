import { createRef, useState, type ComponentProps } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import "~/index.css";
function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}


describe("timeline historical reading", () => {
  it("retains follow cancellation after opening and closing Find", async () => {
    const props = buildProps() satisfies Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries">;
    function Thread({ findOpen }: { findOpen: boolean }) {
      const [follow, setFollow] = useState(true);
      const cancelFollow = () => setFollow(false);
      return <><output>{follow ? "following" : "reading history"}</output>
        <MessagesTimeline {...props} timelineEntries={[]} liveFollowEnabled={follow}
          findOpen={findOpen} findExpanded={findOpen} onManualNavigation={cancelFollow} />
      </>;
    }
    await using screen = await render(<Thread findOpen={false} />);
    expect(screen.container.querySelector("output")?.textContent).toBe("following");
    await screen.rerender(<Thread findOpen />);
    expect(screen.container.querySelector("output")?.textContent).toBe("reading history");
    await screen.rerender(<Thread findOpen={false} />);
    expect(screen.container.querySelector("output")?.textContent).toBe("reading history");
  });
});
