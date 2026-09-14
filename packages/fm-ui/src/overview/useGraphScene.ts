import {
  type Box,
  type GraphGroup,
  layoutGroups,
  type Measurement,
} from "@symmetria/fm-core/overview/layout";
import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
export function useGraphScene(
  folders: ReadonlyMap<string, OverviewFolder>,
  initial?: ReadonlyMap<string, Box>,
) {
  const currentFolders = useRef(folders);
  currentFolders.current = folders;
  const boxes = useRef(new Map<string, GraphGroup>());
  const previous = useRef(initial);
  const [measurements, setMeasurements] = useState(new Map<string, Measurement>(initial));
  useEffect(() => {
    setMeasurements((current) => {
      const next = new Map([...current].filter(([path]) => folders.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [folders]);
  const groups = useMemo(() => {
    const next = layoutGroups(
      [...folders.values()],
      previous.current ?? boxes.current,
      measurements,
    );
    previous.current = undefined;
    boxes.current = new Map(next.map((group) => [group.path, group]));
    return next;
  }, [folders, measurements]);
  const onMeasure = useCallback(
    (path: string, size: Measurement) =>
      setMeasurements((current) => {
        if (!currentFolders.current.has(path)) return current;
        const old = current.get(path);
        if (old?.width === size.width && old.height === size.height) return current;
        return new Map(current).set(path, size);
      }),
    [],
  );
  return {
    groups,
    boxes,
    onMeasure,
    rearrange: () => {
      boxes.current = new Map();
      setMeasurements(new Map());
    },
  };
}
