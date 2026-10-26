import { useEffect, useState } from "react";

import { FileEditorRetention } from "../fileEditorRetention";
import { createMonacoFileModels } from "./monacoFileModelStore";
import { relativePathFromModelKey, type MonacoFileModels } from "./monacoFileModels";
import { MonacoFileModelRegistry } from "./monacoFileModelRegistry";

/**
 * A project's editor models and its retention record, kept across routes. One registry for the
 * application, not a provider, because the undo stack lives in the Monaco model and must outlive
 * route changes such as opening Settings or switching to another project's thread.
 */
export interface ProjectEditorModels {
  readonly models: MonacoFileModels;
  readonly retention: FileEditorRetention;
}

const registry = new MonacoFileModelRegistry<ProjectEditorModels>({
  create: () => {
    const models = createMonacoFileModels();
    const retention = new FileEditorRetention();
    // Kept in step rather than bounded separately. Both are keyed by the same
    // path and both now live as long as the project, so a retention record for
    // a file whose model has been thrown away is a string nobody will ever
    // read again.
    models.onEvict((key) => retention.forget(relativePathFromModelKey(key)));
    return { models, retention };
  },
  dispose: (project) => {
    project.models.disposeAll();
    project.retention.clear();
  },
  // A counter, not a clock: only the order of the releases decides what goes.
  now: (() => {
    let tick = 0;
    return () => (tick += 1);
  })(),
});

/** The project key, which is what the chat view itself keys a worktree on. */
export function projectEditorModelsKey(environmentId: string, cwd: string): string {
  return `${environmentId}:${cwd}`;
}

export function useProjectEditorModels(environmentId: string, cwd: string): ProjectEditorModels {
  const key = projectEditorModelsKey(environmentId, cwd);
  // Acquired once and released on unmount, with no reconciliation for a changed key: the chat
  // view keys the panel on exactly this composite, so another project is another instance.
  // REGRESSION: releasing and acquiring during render disposed Monaco models under a live editor
  // and released the old key twice (render plus stale cleanup). Do not bring it back.
  const [project] = useState(() => registry.acquire(key));
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: releases the registry entry this mount acquired, on unmount
  useEffect(() => () => registry.release(key), [key]);
  return project;
}
