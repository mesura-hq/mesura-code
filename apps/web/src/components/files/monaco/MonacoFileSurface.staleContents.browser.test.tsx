import { act } from "../../../../test/render";
/**
 * Phase 6, criterion 4: no typed key is lost or reverted under the S8 load. The panel's `contents`
 * can lag the model by the editor's own edits; the surface once sent that older text to Neovim as
 * `replaceText` and deleted a newer character (bench `p6-base-s8-web-final`: "measure", then
 * "mesure"). Mounts the whole `MonacoFileSurface` with modal editing on and an editable model.
 */
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => () => import("~/test/nvimEditorHarness"));
vi.mock("~/connection/runtime", async () => (await harness()).mockConnectionRuntime());
vi.mock("~/state/server", async () => (await harness()).mockServerState());
vi.mock("monaco-editor", async () => (await harness()).mockMonacoEditor());
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: Record<string, unknown>) => T) =>
    select({ fontFamilyCode: "", fontSizeCode: 13 }),
}));
vi.mock("~/components/files/useFileSaveCoordinator", () => ({
  useFileSaveCoordinator: () => ({ change: () => {}, flush: async () => {} }),
}));
vi.mock("~/components/files/monaco/monacoFileComments", () => ({
  useMonacoFileComments: () => ({ zones: null, hasOpenDraft: false }),
}));
vi.mock("~/components/files/monaco/monacoEnvironment", () => ({
  ensureMonacoEnvironment: () => {},
}));
/** The file store: what `setProjectFileQueryData` wrote last, per path. */
const fileStore = vi.hoisted(() => new Map<string, string>());
vi.mock("~/components/files/projectFilesQueryState", () => ({
  setProjectFileQueryData: (_environmentId: string, cwd: string, path: string, text: string) => {
    fileStore.set(`${cwd}:${path}`, text);
  },
  getProjectFileContents: (_environmentId: string, cwd: string, path: string) =>
    fileStore.get(`${cwd}:${path}`),
}));

import {
  HARNESS_ENVIRONMENT_ID,
  HARNESS_RELATIVE_PATH,
  editorTransport,
  flushHarness,
  harnessThreadRef,
  makeEditableHarnessModel,
  mountMonacoFileSurface,
  settleUntil,
} from "~/test/nvimEditorHarness";
import { FileEditorRetention } from "../fileEditorRetention";
import { MonacoFileSurface } from "./MonacoFileSurface";
import { monacoFileModelKey, type MonacoFileModels } from "./monacoFileModels";

const CWD = "/harness/project";
const LINES = ["to measure latency", "second line"];
const original = LINES.join("\n");

/** The `contents` prop, as the panel's state hands it to the surface. */
function makeContentsProp(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    set: (next: string) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => value,
  };
}

function useContentsProp(prop: ReturnType<typeof makeContentsProp>) {
  return useSyncExternalStore(prop.subscribe, prop.read);
}

let mounted: Awaited<ReturnType<typeof mountMonacoFileSurface>> | undefined;

async function setupBrowserFixture0() {
  editorTransport.reset();
  fileStore.clear();

  return {
    async [Symbol.asyncDispose]() {
      await mounted?.unmount();
      mounted = undefined;
      vi.unstubAllGlobals();
    },
  };
}

/** Neovim's text for line 1 after a key, as its `lines` event carries it. */
async function neovimTypes(line1: string, col: number) {
  await act(async () => {
    editorTransport.emit(
      { type: "lines", relativePath: HARNESS_RELATIVE_PATH, first: 0, last: 1, lines: [line1] },
      { type: "cursor", line: 1, col },
    );
  });
}

describe("MonacoFileSurface under a burst of Neovim edits (phase 6)", () => {
  it("never sends Neovim an older text of its own as an external edit when a render lags the model", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const model = makeEditableHarnessModel(
      LINES,
      monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
    );
    editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, mode: "i" });
    const contents = makeContentsProp(original);
    function Surface({ models }: { readonly models: MonacoFileModels }) {
      return (
        <MonacoFileSurface
          environmentId={HARNESS_ENVIRONMENT_ID}
          cwd={CWD}
          relativePath={HARNESS_RELATIVE_PATH}
          contents={useContentsProp(contents)}
          resolvedTheme="dark"
          wordWrap
          revealLine={null}
          revealRequestId={0}
          retention={new FileEditorRetention()}
          models={models}
          composerDraftTarget={harnessThreadRef}
          threadRef={harnessThreadRef}
          modalEditing
          onPendingChange={() => {}}
        />
      );
    }
    mounted = await mountMonacoFileSurface({
      layout: { model: model as never, wrapColumn: 120, lineHeight: 18, height: 360 },
      renderSurface: (models) => <Surface models={models as MonacoFileModels} />,
    });
    await settleUntil(
      () => editorTransport.requests.some((request) => request.method === "open"),
      "the surface opened the file in Neovim",
    );
    await flushHarness();

    // Two keys land in one burst: "measure" loses nothing yet.
    await neovimTypes("to measure latency!", 20);
    const afterFirst = model.getValue();
    await neovimTypes("to measure latency!?", 21);
    expect(model.getValue()).toBe(["to measure latency!?", "second line"].join("\n"));

    // The panel's passive effect catches up one edit late: it hands the surface
    // the text from before the second key.
    await act(async () => contents.set(afterFirst));
    await flushHarness();

    expect(
      editorTransport.requests.filter((request) => request.method === "replaceText"),
      "the surface wrote its own older text back into Neovim",
    ).toEqual([]);
    expect(model.getValue()).toBe(["to measure latency!?", "second line"].join("\n"));
  });

  it("still sends Neovim a write from outside the editor that reaches the file store", async () => {
    await using _browserFixture0 = await setupBrowserFixture0();

    const model = makeEditableHarnessModel(
      LINES,
      monacoFileModelKey(HARNESS_ENVIRONMENT_ID, CWD, HARNESS_RELATIVE_PATH),
    );
    editorTransport.setSnapshot({ lines: LINES, cursor: { line: 1, col: 1 }, mode: "n" });
    const contents = makeContentsProp(original);
    function Surface({ models }: { readonly models: MonacoFileModels }) {
      return (
        <MonacoFileSurface
          environmentId={HARNESS_ENVIRONMENT_ID}
          cwd={CWD}
          relativePath={HARNESS_RELATIVE_PATH}
          contents={useContentsProp(contents)}
          resolvedTheme="dark"
          wordWrap
          revealLine={null}
          revealRequestId={0}
          retention={new FileEditorRetention()}
          models={models}
          composerDraftTarget={harnessThreadRef}
          threadRef={harnessThreadRef}
          modalEditing
          onPendingChange={() => {}}
        />
      );
    }
    mounted = await mountMonacoFileSurface({
      layout: { model: model as never, wrapColumn: 120, lineHeight: 18, height: 360 },
      renderSurface: (models) => <Surface models={models as MonacoFileModels} />,
    });
    await settleUntil(
      () => editorTransport.requests.some((request) => request.method === "open"),
      "the surface opened the file in Neovim",
    );
    await flushHarness();

    // An agent rewrites the file: the store and the prop both carry its text.
    const agentText = ["to measure latency", "an agent's line"].join("\n");
    fileStore.set(`${CWD}:${HARNESS_RELATIVE_PATH}`, agentText);
    await act(async () => contents.set(agentText));
    await settleUntil(
      () => editorTransport.requests.some((request) => request.method === "replaceText"),
      "the agent's write reached Neovim",
    );
  });
});
