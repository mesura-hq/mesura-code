import { overviewPaths } from "@symmetria/fm-core/overview/model";
import { useEffect, useMemo, useRef } from "react";
import type { OverviewModel } from "../overview/useOverview.ts";
import { useSearchSession } from "../useSearch.ts";
import { type TreeAnchor, type TreeRecord, visibleFallback } from "./state.ts";
import type { useTreeState } from "./useTreeState.ts";

export function useTreeSearch(
  root: string,
  model: OverviewModel,
  state: ReturnType<typeof useTreeState>,
  record: TreeRecord,
  viewport: HTMLElement | null,
) {
  const targets = useMemo(
    () => [...overviewPaths(root, model.folders)].sort().map((path) => ({ key: path, text: path })),
    [root, model.folders],
  );
  const captured = useRef<{ path: string; anchor: TreeAnchor | null }>({
    path: root,
    anchor: null,
  });
  const focus = () => viewport?.focus({ preventScroll: true });
  const session = useSearchSession({
    targets,
    scope: root,
    selected: state.shape.selected,
    choose: state.chooseSearch,
    capture: () => {
      captured.current = clearedPosition(state, record);
    },
    restore: () => state.restoreSearch(captured.current.path, captured.current.anchor),
  });
  const clear = () => {
    const position = clearedPosition(state, record);
    session.clear();
    state.restoreSearch(position.path, position.anchor);
    focus();
  };
  const latest = useRef({ state, record });
  latest.current = { state, record };
  useEffect(
    () => () => {
      const { state, record } = latest.current;
      const position = clearedPosition(state, record);
      record.shape = { ...record.shape, selected: position.path };
      record.anchor = position.anchor;
    },
    [],
  );
  return {
    ...session,
    open: () => {
      clear();
      session.open();
    },
    confirm: () => {
      session.confirm();
      focus();
    },
    cancel: () => {
      session.cancel();
      focus();
    },
    clear,
  };
}
function clearedPosition(state: ReturnType<typeof useTreeState>, record: TreeRecord) {
  const path = visibleFallback(state.shape.selected, state.baseRows);
  const anchor =
    path === state.shape.selected
      ? record.anchor
      : { path, offset: 0, left: record.anchor?.left ?? 0 };
  return { path, anchor };
}
