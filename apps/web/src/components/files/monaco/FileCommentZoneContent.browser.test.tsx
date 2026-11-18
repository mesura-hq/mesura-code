import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { FileCommentZoneContent } from "./monacoFileComments";

it("offers Mesura dictation in a file comment draft", async () => {
  await using screen = await render(
    <FileCommentZoneContent
      environmentId={EnvironmentId.make("file-comment-environment")}
      relativePath="src/app.ts"
      group={{
        endLine: 4,
        entries: [{ id: "draft-1", kind: "draft", startLine: 2, endLine: 4, text: "" }],
      }}
      onCancel={vi.fn()}
      onComment={vi.fn()}
      onDelete={vi.fn()}
      onTextChange={vi.fn()}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .toBeInTheDocument();
});
