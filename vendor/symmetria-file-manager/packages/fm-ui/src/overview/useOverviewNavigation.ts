import { isAncestorPath } from "@symmetria/fm-core/overview/model";
import { useCallback, useEffect, useRef, useState } from "react";

export interface TreeOriginHost {
  tab: string;
  reveal(path: string): void;
  exit(): void;
}
interface Origin {
  view: "tree" | "miller";
  root: string;
  tab: string;
}
interface Options {
  path: string;
  treeRoot: string | null;
  tree: TreeOriginHost | undefined;
  reveal(path: string): void;
  navigate(path: string): void;
}
export function useOverviewNavigation(options: Options) {
  const { tree, treeRoot, path } = options;
  const [root, setRoot] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const close = useCallback(() => setRoot(null), []);
  const tab = tree?.tab;
  const previousTab = useRef(tab);
  useEffect(() => {
    if (previousTab.current === tab) return;
    previousTab.current = tab;
    close();
  }, [tab, close]);
  const toggle = () => {
    if (root !== null) {
      close();
      return;
    }
    const next = treeRoot ?? path;
    setOrigin({ view: treeRoot === null ? "miller" : "tree", root: next, tab: tree?.tab ?? "" });
    setRoot(next);
  };
  return {
    root,
    close,
    toggle,
    focus: setRoot,
    revealDestination: origin?.view === "tree" ? "tree" : "Miller",
    reveal: (selected: string) => {
      close();
      revealFromOverview(selected, root, origin, options);
    },
  };
}
function revealFromOverview(
  selected: string,
  root: string | null,
  origin: Origin | null,
  options: Options,
) {
  const { tree, reveal, navigate } = options;
  if (
    origin?.view === "tree" &&
    tree?.tab === origin.tab &&
    isAncestorPath(origin.root, selected)
  ) {
    tree.reveal(selected);
    return;
  }
  tree?.exit();
  if (selected === root) navigate(selected);
  else reveal(selected);
}
