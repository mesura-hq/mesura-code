import { describe, expect, it } from "vite-plus/test";

import { EDITOR_WORKER_LABEL, workerForLabel } from "./monacoWorkers";

describe("workerForLabel", () => {
  it("returns the real editor worker for the editor worker label", () => {
    const editorWorker = { name: "editor" } as unknown as Worker;
    const inertWorker = { name: "inert" } as unknown as Worker;

    const chosen = workerForLabel(EDITOR_WORKER_LABEL, {
      editorWorker: () => editorWorker,
      inertWorker: () => inertWorker,
    });

    expect(chosen).toBe(editorWorker);
  });

  it("returns an inert worker for every language service label", () => {
    const editorWorker = { name: "editor" } as unknown as Worker;
    const inertWorker = { name: "inert" } as unknown as Worker;
    const factories = { editorWorker: () => editorWorker, inertWorker: () => inertWorker };

    // The language server lives on the backend. If one of these ever gets a
    // real worker, Monaco starts answering with its own bundled analysis, which
    // disagrees with the backend and ships the largest part of the bundle.
    for (const label of ["typescript", "javascript", "json", "css", "html", "anything-new"]) {
      expect(workerForLabel(label, factories)).toBe(inertWorker);
    }
  });
});
