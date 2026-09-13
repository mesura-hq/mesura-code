import { useEffect, useState } from "react";

import { FileEditorRetention } from "../fileEditorRetention";
import { createMonacoFileModels } from "./monacoFileModelStore";
import { relativePathFromModelKey, type MonacoFileModels } from "./monacoFileModels";
import { MonacoFileModelRegistry } from "./monacoFileModelRegistry";

/**
 * A project's editor models and its retention record, kept across routes.
 *
 * One registry for the application, built here rather than in a provider,
 * because what it holds has to outlive every component that could host it:
 * opening Settings and switching to a thread in another project are both route
 * changes, and the undo stack lives in the Monaco model.
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
  // Acquired once and released on unmount, with no reconciliation for a key
  // that changed, because it cannot: the chat view mounts the panel with a
  // React `key` of exactly this composite, so a different project is a
  // different component instance rather than a re-render of this one.
  //
  // An earlier version released and acquired during render to cover the case
  // anyway. That is a side effect in a render body, which React may run more
  // than once and may throw away — and what it disposes here is Monaco models
  // with a live editor attached. It also released the old key twice, once in
  // the render and once in the effect cleanup that still closed over it, which
  // would take a project's models out from under a second panel on the same
  // project. A safety net that can do that is worse than the case it covers,
  // and the case it covers does not exist.
  const [project] = useState(() => registry.acquire(key));
  useEffect(() => () => registry.release(key), [key]);
  return project;
}
