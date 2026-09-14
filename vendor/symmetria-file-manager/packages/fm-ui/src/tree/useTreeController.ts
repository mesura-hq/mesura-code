import { useEffect, useRef } from "react";
import { isTreeDirectory, type TreeRow } from "./model.ts";
import type { TreeController, TreePort } from "./useTreeMode.ts";

export function useTreeController(
  port: TreePort,
  commands: TreeController,
  current: TreeRow | undefined,
  editing: boolean,
  count: number,
  viewport: HTMLElement | null,
  autoFocus: boolean,
) {
  const controller = useRef(commands);
  controller.current = commands;
  useEffect(
    () =>
      port.connect({
        command: (name) => controller.current.command(name),
        reveal: (path) => controller.current.reveal(path),
        cancel: () => controller.current.cancel(),
      }),
    [port.connect],
  );
  useEffect(() => {
    port.search?.({ active: editing, count });
  }, [port.search, editing, count]);
  useEffect(() => {
    if (current)
      port.select({
        name: current.name,
        path: current.path,
        isDirectory: isTreeDirectory(current),
        isImage: false,
        mimeType: "",
      });
  }, [current, port.select]);
  // A host that mounts the tree beside another input (a composer, an editor)
  // must not lose focus to it; the tree then takes focus only when asked.
  useEffect(() => {
    if (autoFocus) viewport?.focus({ preventScroll: true });
  }, [viewport, autoFocus]);
}
