import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  drafts: {} as Record<string, import("./use-composer-drafts").ComposerDraft>,
  uploads: {} as Record<
    string,
    import("../lib/composerAttachmentUploadQueue").ComposerAttachmentUploadState
  >,
  preparations: {} as Record<string, number>,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { composerDraftsAtom: Atom.make({}).pipe(Atom.keepAlive), clearComposerDraft: vi.fn() };
});
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    ...(await import("../lib/composerAttachmentUploadQueue")),
    composerAttachmentUploadsAtom: Atom.make({}).pipe(Atom.keepAlive),
  };
});
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: {
              questionAttachments: true,
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 20_000_000 },
            },
          },
        },
      ],
    ]),
}));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
  }),
}));
vi.mock("./use-thread-detail", () => ({ useSelectedThreadDetail: () => null }));

import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { questionAttachmentDraftKey } from "./question-attachments";
import { usePendingUserInputDrafts } from "./use-selected-thread-requests";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "./atom-registry";
import { composerDraftsAtom } from "./use-composer-drafts";
import { composerAttachmentUploadsAtom } from "./composer-attachment-uploads";
import { questionAttachmentPreparationAtom } from "./question-attachments";
import { buildPendingUserInputAnswers } from "../lib/threadActivity";

const environmentId = EnvironmentId.make("environment-1");
const key = (question: string) =>
  questionAttachmentDraftKey(
    environmentId,
    ThreadId.make("thread-1"),
    ApprovalRequestId.make("request-1"),
    question,
  );
const request = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-09-08T00:00:00Z",
  dismissible: true,
  questions: ["first", "second"].map((id) => ({
    id,
    header: id,
    question: `Attach ${id} file`,
    options: [],
    allowCustomAnswer: true,
    multiSelect: false,
  })),
};
function submitButtonMarkup() {
  appAtomRegistry.set(composerDraftsAtom, fixture.drafts);
  appAtomRegistry.set(composerAttachmentUploadsAtom, fixture.uploads);
  appAtomRegistry.set(questionAttachmentPreparationAtom, fixture.preparations);
  function Probe() {
    const drafts = usePendingUserInputDrafts(environmentId, ThreadId.make("thread-1"), request);
    return (
      <button disabled={buildPendingUserInputAnswers(request.questions, drafts) === null}>
        Submit answers
      </button>
    );
  }
  return renderToStaticMarkup(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
  );
}
beforeEach(() => {
  appAtomRegistry.reset();
  fixture.preparations = {};
  fixture.drafts = Object.fromEntries(
    ["first", "second"].map((id) => [
      key(id),
      {
        text: "",
        attachments: [
          {
            id,
            type: "file",
            name: `${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: `file:///${id}.txt`,
          },
        ],
      },
    ]),
  );
  fixture.uploads = { "environment-1:first": { status: "ready" } };
});
describe("question attachment submission readiness", () => {
  it.each([
    undefined,
    { status: "uploading", progress: 0.5 },
    { status: "failed", reason: "Offline" },
  ] as const)("keeps Submit disabled until all question uploads finish: %j", (state) => {
    if (state) fixture.uploads["environment-1:second"] = state;
    expect(submitButtonMarkup()).toContain("disabled");
    fixture.uploads["environment-1:second"] = { status: "ready" };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("ignores an upload in another environment", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.uploads["environment-2:second"] = { status: "uploading", progress: 0.5 };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("waits for attachment preparation even when uploads are ready", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.preparations[key("first")] = 1;
    expect(submitButtonMarkup()).toContain("disabled");
  });
});
