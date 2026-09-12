import { describe, expect, it } from "vite-plus/test";

import {
  ALL_TYPESCRIPT_FEATURES_OFF,
  ALL_JSON_FEATURES_OFF,
  ALL_CSS_FEATURES_OFF,
  ALL_HTML_FEATURES_OFF,
  EDITOR_WORKER_LABEL,
  workerForLabel,
} from "./monacoWorkers";

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

describe("mode configurations", () => {
  const families = {
    typescript: ALL_TYPESCRIPT_FEATURES_OFF,
    json: ALL_JSON_FEATURES_OFF,
    css: ALL_CSS_FEATURES_OFF,
    html: ALL_HTML_FEATURES_OFF,
  };

  it("has every feature switched off in every family", () => {
    for (const [family, configuration] of Object.entries(families)) {
      const entries = Object.entries(configuration);
      expect(entries.length, `${family} has no features listed`).toBeGreaterThan(0);
      for (const [feature, enabled] of entries) {
        expect(enabled, `${family}.${feature} is on`).toBe(false);
      }
    }
  });

  it("switches off the features that would otherwise start a worker", () => {
    // Completion and diagnostics are the two that make a language mode spin up
    // its worker, so they are named rather than left to the sweep above.
    expect(ALL_TYPESCRIPT_FEATURES_OFF.completionItems).toBe(false);
    expect(ALL_TYPESCRIPT_FEATURES_OFF.diagnostics).toBe(false);
    expect(ALL_JSON_FEATURES_OFF.completionItems).toBe(false);
    expect(ALL_JSON_FEATURES_OFF.diagnostics).toBe(false);
    expect(ALL_CSS_FEATURES_OFF.completionItems).toBe(false);
    expect(ALL_HTML_FEATURES_OFF.completionItems).toBe(false);
  });
});
