import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import {
  fieldJob,
  setupFieldDictation,
  startedJobIds,
} from "~/dictation/fieldDictation.testFixtures";
import { publishJobs } from "~/dictation/fieldDictation.testMocks";
import { getRenderablePatch } from "~/lib/diffRendering";
import { GuideExcerpt, type ExcerptCommenting } from "./GuideExcerpt";

vi.mock("~/dictation/dictationTransport", async () =>
  (await import("~/dictation/fieldDictation.testMocks")).mockDictationTransportModule(),
);
vi.mock("~/state/dictation", async (importOriginal) =>
  (await import("~/dictation/fieldDictation.testMocks")).mockDictationJobsModule(importOriginal),
);

// The real diff draws in a shadow root; this stand-in opens a draft the way its gutter does.
vi.mock("@pierre/diffs/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs/react")>()),
  FileDiff: (props: {
    readonly options: { readonly onGutterUtilityClick?: (range: SelectedLineRange) => void };
    readonly lineAnnotations: ReadonlyArray<{ readonly side: string; readonly lineNumber: number }>;
    readonly renderAnnotation: (annotation: never) => ReactNode;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.options.onGutterUtilityClick?.({ start: 2, end: 2, side: "additions" })
        }
      >
        Comment on line 2
      </button>
      {props.lineAnnotations.map((annotation) => (
        <div key={`${annotation.side}:${annotation.lineNumber}`}>
          {props.renderAnnotation(annotation as never)}
        </div>
      ))}
    </div>
  ),
}));

const file = (() => {
  const renderable = getRenderablePatch(
    [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,3 @@",
      " line 1",
      "+line 2",
      " line 3",
      "",
    ].join("\n"),
    "guide-excerpt-dictation-test",
  );
  if (renderable?.kind !== "files") throw new Error("Expected a parsed patch.");
  return renderable.files[0] as FileDiffMetadata;
})();

const commenting: ExcerptCommenting = {
  canComment: true,
  rangeComments: false,
  completionScope: null,
  pending: [],
  onComment: vi.fn(),
  onRemove: vi.fn(),
  onAskAgent: null,
  dictation: {
    environmentId: EnvironmentId.make("guide-dictation-environment"),
    projectId: ProjectId.make("guide-dictation-project"),
    scope: "review-key",
  },
};

it("offers Mesura dictation in a review guide line comment", async () => {
  await using screen = await render(
    <GuideExcerpt
      excerpt={{ path: "file.ts", side: "new", start: 1, end: 3, caption: "" }}
      file={file}
      loading={false}
      notes={[]}
      commenting={commenting}
      loadDiffFiles={vi.fn()}
      onOpenFile={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "Comment on line 2" }).click();
  await expect.element(screen.getByRole("textbox", { name: /Comment on lines/ })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Start voice dictation" }))
    .toBeInTheDocument();
});

it("keeps dictation with the guide draft that recorded it when another draft shows the same line", async () => {
  setupFieldDictation();
  const onComment = vi.fn();
  const sharedCommenting = { ...commenting, onComment };
  // An old-side and a new-side excerpt of one replacement both show the added line.
  const excerpt = (side: "old" | "new") => (
    <GuideExcerpt
      excerpt={{ path: "file.ts", side, start: 1, end: 3, caption: "" }}
      file={file}
      loading={false}
      notes={[]}
      commenting={sharedCommenting}
      loadDiffFiles={vi.fn()}
      onOpenFile={vi.fn()}
    />
  );
  await using screen = await render(
    <>
      {excerpt("old")}
      {excerpt("new")}
    </>,
  );
  await screen.getByRole("button", { name: "Comment on line 2" }).nth(0).click();
  await screen.getByRole("button", { name: "Comment on line 2" }).nth(1).click();
  const drafts = screen.getByRole("textbox", { name: /Comment on lines/ });
  await expect.element(drafts.nth(1)).toBeVisible();
  await drafts.nth(0).fill("First");
  await drafts.nth(1).fill("Second");

  await screen.getByRole("button", { name: "Start voice dictation" }).nth(0).click();
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  await screen.getByRole("button", { name: "Add to review" }).nth(0).click();
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  // Closing the other draft neither drops the held submission nor takes the job.
  await screen.getByRole("button", { name: "Cancel" }).nth(1).click();
  await expect.element(drafts.nth(1)).not.toBeInTheDocument();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Sends when transcribed");

  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "spoken" })]);
  await vi.waitFor(() => expect(onComment).toHaveBeenCalledOnce());
  expect(onComment).toHaveBeenCalledWith(expect.objectContaining({ body: "First spoken" }));
});

it("inserts a transcript only into the guide draft that recorded it", async () => {
  setupFieldDictation();
  const excerpt = (side: "old" | "new") => (
    <GuideExcerpt
      excerpt={{ path: "file.ts", side, start: 1, end: 3, caption: "" }}
      file={file}
      loading={false}
      notes={[]}
      commenting={commenting}
      loadDiffFiles={vi.fn()}
      onOpenFile={vi.fn()}
    />
  );
  await using screen = await render(
    <>
      {excerpt("old")}
      {excerpt("new")}
    </>,
  );
  await screen.getByRole("button", { name: "Comment on line 2" }).nth(0).click();
  await screen.getByRole("button", { name: "Comment on line 2" }).nth(1).click();
  const drafts = screen.getByRole("textbox", { name: /Comment on lines/ });
  await expect.element(drafts.nth(1)).toBeVisible();
  await screen.getByRole("button", { name: "Start voice dictation" }).nth(1).click();
  await screen.getByRole("button", { name: "Stop and transcribe" }).click();
  await vi.waitFor(() => expect(startedJobIds()).toHaveLength(1));
  publishJobs([fieldJob(startedJobIds()[0]!, { status: "completed", text: "only here" })]);
  await expect.element(drafts.nth(1)).toHaveValue("only here");
  await expect.element(drafts.nth(0)).toHaveValue("");
});
