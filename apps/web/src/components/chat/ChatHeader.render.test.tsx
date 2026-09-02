import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// ChatHeader reaches into the atom store and the thread action menu on every
// render. Neither is what these tests are about, so both are stubbed to the
// smallest shape the component consumes.
vi.mock("../../state/threads", () => ({
  threadEnvironment: { updateMetadata: {} },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {} }),
}));
vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: () => null,
}));

const { ChatHeader } = await import("./ChatHeader");

const THREAD_TITLE = "A thread";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const NO_EDITORS: ReadonlyArray<EditorId> = [];

function renderHeader(rightPanelOpen = false) {
  return renderToStaticMarkup(
    <ChatHeader
      activeThreadEnvironmentId={"env-test" as EnvironmentId}
      activeThreadId={"thread-test" as ThreadId}
      activeThreadTitle={THREAD_TITLE}
      isServerThread
      activeProjectName="mesura-code"
      activeProjectCwd="/tmp/mesura-code"
      activeProjectFaviconPath={null}
      openInCwd="/tmp/mesura-code"
      activeProjectScripts={[]}
      preferredScriptId={null}
      keybindings={EMPTY_KEYBINDINGS}
      availableEditors={NO_EDITORS}
      rightPanelOpen={rightPanelOpen}
      gitCwd="/tmp/mesura-code"
      onNewThreadInProject={() => {}}
      onRunProjectScript={() => {}}
      onAddProjectScript={async () => undefined as never}
      onUpdateProjectScript={async () => undefined as never}
      onDeleteProjectScript={async () => undefined as never}
    />,
  );
}

/**
 * This fork removed the header toolbar: the project actions control, the editor
 * picker and the git quick action. Upstream still ships all three, so a weekly
 * merge that resolves ChatHeader.tsx in upstream's favor would put the buttons
 * back with nothing else failing. These tests are that alarm.
 */
describe("ChatHeader actions strip", () => {
  it("renders the actions strip empty", () => {
    const html = renderHeader();

    // Guards the negative assertion below: without this the test would pass on
    // a header that rendered nothing at all.
    expect(html).toContain(THREAD_TITLE);
    // Matching "tag immediately followed by its close" beats listing control
    // labels, because a restored control would carry whatever label upstream
    // gives it by then.
    expect(html).toMatch(/<div[^>]*data-chat-header-actions[^>]*><\/div>/);
  });

  it("keeps the inset that reserves space for the floating panel controls", () => {
    expect(renderHeader(false)).toContain("pr-16");
    expect(renderHeader(true)).not.toContain("pr-16");
  });
});
