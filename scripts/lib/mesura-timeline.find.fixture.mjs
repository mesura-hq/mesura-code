import React, {
  Component,
  Profiler,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { LegendList } from "@legendapp/list/react";
import { TIMELINE_FIND_VISIBLE_CONTENT_POSITION } from "@mesura/timeline-find-policy";
import { useThreadFindNavigation } from "@mesura/thread-find-navigation";

const parameters = new URLSearchParams(location.search);
const legacyPolicy = parameters.get("policy") === "legacy";
const actualNavigation = parameters.get("navigation") === "hook";
const calibrationCount = 12;
const memberCount = 128;
// The imperative API waits for data settlement. Keep this middle target beyond
// the initially visible new rows so its predecessor still needs measurement.
const targetMemberIndex = 32;
const targetOrdinal = 2000 + targetMemberIndex;
const readingOrdinal = 107;
const paragraph =
  "A careful reader follows an ordinary paragraph through the measured chat column. These words wrap naturally as the available line width changes. ";
const calibrationRows = Array.from({ length: calibrationCount }, (_, index) => ({
  id: `calibration-${index}`,
  ordinal: index,
  type: "message:assistant",
  body: paragraph.repeat(24),
}));
const readingRows = Array.from({ length: 8 }, (_, index) => ({
  id: `reading-${index}`,
  ordinal: 100 + index,
  type: "work",
  body: "A completed work item.",
}));
const summary = {
  id: "historical-summary",
  ordinal: 1000,
  type: "turn-fold",
  body: "A collapsed historical turn.",
};
const members = Array.from({ length: memberCount }, (_, index) => ({
  id: `member-${index}`,
  ordinal: 2000 + index,
  type: "message:assistant",
  body:
    index === targetMemberIndex
      ? "A short historical assistant message with a synthetic navigation beacon."
      : "A short historical assistant message.",
}));
const trailingRows = Array.from({ length: 16 }, (_, index) => ({
  id: `trailing-${index}`,
  ordinal: 3000 + index,
  type: "work",
  body: "A later completed work item.",
}));
const targetKey = members[targetMemberIndex].id;
const stamp = () => ({ action: telemetry.action, time: performance.now() });
const telemetry = (window.telemetry = {
  action: 0,
  loaded: 0,
  commits: [],
  measurements: [],
  signals: [],
  targetPositions: [],
  requests: [],
  completions: [],
  scrolls: [],
  depthErrors: [],
  otherErrors: [],
  mountedLists: 0,
  removedLists: 0,
});
function recordError(error) {
  const value = { ...stamp(), message: String(error?.message ?? error) };
  if (value.message.includes("Maximum update depth exceeded")) telemetry.depthErrors.push(value);
  else telemetry.otherErrors.push(value);
}
window.addEventListener("error", (event) => recordError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => recordError(event.reason));

class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    recordError(error);
  }
  render() {
    return this.state.failed
      ? React.createElement(
          "div",
          { "data-error-boundary": true },
          "The reduction stopped after an actual React error.",
        )
      : this.props.children;
  }
}
function DepthControl() {
  const [value, setValue] = useState(0);
  // oxlint-disable-next-line react/set-state-in-effect -- The isolated detector deliberately triggers React's real depth limit; measured list cases never mount it.
  useLayoutEffect(() => setValue(value + 1));
  return React.createElement("div", null, value);
}
function Row({ item }) {
  return React.createElement(
    "article",
    { className: "row", "data-ordinal": item.ordinal, "data-timeline-row-id": item.id },
    React.createElement("p", { "data-thread-find-text": true }, item.body),
  );
}
function FindNavigation(props) {
  useThreadFindNavigation(props);
  return null;
}
const keyExtractor = (item) => item.id;
const getItemType = (item) => item.type;
const renderItem = ({ item }) => React.createElement(Row, { item });

function App() {
  const [narrow, setNarrow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [appended, setAppended] = useState(false);
  const [findActive, setFindActive] = useState(false);
  const [container, setContainer] = useState(null);
  const [ready, setReady] = useState(false);
  const list = useRef(null);
  const stops = useRef([]);
  const issuedQuery = useRef(false);
  const pendingRequests = useRef(0);
  const rows = useMemo(
    () => [
      ...calibrationRows,
      ...readingRows,
      ...(expanded ? members : [summary]),
      ...trailingRows,
      ...(appended
        ? [{ id: "later-work", ordinal: 3016, type: "work", body: "A later completed work item." }]
        : []),
    ],
    [expanded, appended],
  );
  const readingMaintenance = useMemo(() => ({ data: true, size: true }), []);
  const match = useMemo(
    () => (findActive ? { entryId: targetKey, runId: null, occurrence: 0 } : null),
    [findActive],
  );
  const onLoadEarlier = useCallback(() => setExpanded(true), []);
  const historyControls = useMemo(
    () => ({ hasMoreHistory: !expanded, loading: false, error: null, onLoadEarlier }),
    [expanded, onLoadEarlier],
  );
  useLayoutEffect(() => {
    telemetry.mountedLists++;
    return () => {
      telemetry.removedLists++;
    };
  }, []);

  const navigate = useCallback(
    (ordinal, query) => {
      const handle = list.current;
      if (!handle) throw new Error("The list handle is absent before navigation.");
      const index = rows.findIndex((item) => item.ordinal === ordinal);
      if (index < 0) throw new Error("The requested synthetic key is absent.");
      const state = handle.getState();
      telemetry.requests.push({
        ...stamp(),
        query: query ? 1 : 0,
        ordinal,
        index,
        coreIndex: state.indexByKey(rows[index].id) ?? -1,
        dataLength: rows.length,
        coreDataLength: state.data.length,
        knownSize: state.sizeAtIndex(index) ?? -1,
        position: state.positionAtIndex(index) ?? -1,
        scroll: state.scroll,
        viewOffset: query ? 96 : 0,
        average: state.getAverageItemSizes()["message:assistant"]?.average ?? -1,
        knownMemberCount: members.reduce(
          (count, item) => count + (state.sizes.has(item.id) ? 1 : 0),
          0,
        ),
        measurements: telemetry.measurements.length,
        commits: telemetry.commits.length,
      });
      pendingRequests.current++;
      return Promise.resolve(
        handle.scrollToIndex({ index, animated: false, viewOffset: query ? 96 : 0 }),
      )
        .then(() => {
          telemetry.completions.push({ ...stamp(), ordinal, query: query ? 1 : 0 });
        })
        .catch((error) => {
          recordError(error);
          throw error;
        })
        .finally(() => {
          pendingRequests.current--;
        });
    },
    [rows],
  );
  useLayoutEffect(() => {
    if (actualNavigation || !expanded || issuedQuery.current) return;
    issuedQuery.current = true;
    // The query owns one stable target. It starts after the data commit, before
    // a new frame can settle the inserted members' estimated positions.
    void navigate(targetOrdinal, true).catch(() => {});
  }, [expanded, navigate]);

  function rowSnapshot(item, state, viewport) {
    const index = state?.indexByKey(item.id);
    const element = document.querySelector(`[data-ordinal="${item.ordinal}"]`);
    const rectangle = element?.getBoundingClientRect();
    return {
      ordinal: item.ordinal,
      index: index ?? -1,
      known: state?.sizes.has(item.id) ? 1 : 0,
      knownSize: index === undefined ? -1 : (state.sizeAtIndex(index) ?? -1),
      position: index === undefined ? -1 : (state.positionAtIndex(index) ?? -1),
      mounted: element ? 1 : 0,
      width: rectangle?.width ?? -1,
      height: rectangle?.height ?? -1,
      top: rectangle && viewport ? rectangle.top - viewport.top : -1,
      bottom: rectangle && viewport ? rectangle.bottom - viewport.top : -1,
    };
  }
  // Publish the test adapter after commit. Methods read geometry only when the runner invokes them.
  useLayoutEffect(() => {
    window.fixture = {
      calibrationCount,
      memberCount,
      targetOrdinal,
      readingOrdinal,
      narrow() {
        setNarrow(true);
      },
      restore() {
        setNarrow(false);
      },
      position(ordinal) {
        return navigate(ordinal, false);
      },
      expand() {
        setFindActive(true);
        if (!actualNavigation) setExpanded(true);
      },
      closeFind() {
        setFindActive(false);
      },
      appendAfterClose() {
        setAppended(true);
      },
      observe() {
        if (stops.current.length || !list.current) return;
        const state = list.current.getState();
        for (const [signal, name] of ["totalSize", "lastPositionUpdate"].entries()) {
          stops.current.push(
            state.listen(name, (value) => {
              if (typeof value === "number") telemetry.signals.push({ ...stamp(), signal, value });
            }),
          );
        }
        // These callbacks retain scalars only. They do not read geometry or
        // state, call list methods, or enqueue a React update.
        stops.current.push(
          state.listenToPosition(targetKey, (value) => {
            telemetry.targetPositions.push({ ...stamp(), value });
          }),
        );
      },
      snapshot() {
        const element = document.querySelector(".timeline");
        const viewport = element?.getBoundingClientRect();
        const state = list.current?.getState();
        const average = state?.getAverageItemSizes()["message:assistant"];
        const knownIndices = state
          ? state.data.flatMap((item, index) => {
              const size = state.sizeAtIndex(index);
              return typeof size === "number" ? [{ index, ordinal: item.ordinal, size }] : [];
            })
          : [];
        return {
          viewportWidth: viewport?.width ?? -1,
          viewportHeight: viewport?.height ?? -1,
          contentLength: state?.contentLength ?? -1,
          scroll: state?.scroll ?? -1,
          scrollLength: state?.scrollLength ?? -1,
          domScroll: element?.scrollTop ?? -1,
          average: average?.average ?? -1,
          averageCount: average?.count ?? 0,
          knownIndices,
          knownCount: knownIndices.length,
          knownMaximum: knownIndices.length
            ? Math.max(...knownIndices.map((item) => item.size))
            : -1,
          calibrations: calibrationRows.map((item) => rowSnapshot(item, state, viewport)),
          target: rowSnapshot(members[targetMemberIndex], state, viewport),
          predecessor: rowSnapshot(members[targetMemberIndex - 1], state, viewport),
          dataLength: rows.length,
          coreDataLength: state?.data.length ?? -1,
          duplicateKeys: rows.length - new Set(rows.map((item) => item.id)).size,
          expanded: expanded ? 1 : 0,
          narrow: narrow ? 1 : 0,
          sizeMaintenance: legacyPolicy ? 0 : 1,
          findActive: findActive ? 1 : 0,
          endFollow: 0,
          highlightCount: CSS.highlights?.get("t3-thread-find-active")?.size ?? 0,
          range: (() => {
            const active = CSS.highlights?.get("t3-thread-find-active");
            const range = active ? [...active][0] : null;
            const rect = range?.getBoundingClientRect();
            return {
              connected: range?.startContainer.isConnected ? 1 : 0,
              height: rect?.height ?? -1,
              top: rect && viewport ? rect.top - viewport.top : -1,
              bottom: rect && viewport ? rect.bottom - viewport.top : -1,
            };
          })(),
          knownMemberCount: state
            ? members.reduce((count, item) => count + (state.sizes.has(item.id) ? 1 : 0), 0)
            : -1,
          measuredCount: telemetry.measurements.length,
          signalCount: telemetry.signals.length,
          commitCount: telemetry.commits.length,
          targetPositionCount: telemetry.targetPositions.length,
          pendingRequests: pendingRequests.current,
          depthErrors: telemetry.depthErrors.length,
          otherErrors: telemetry.otherErrors.length,
        };
      },
      dispose() {
        for (const stop of stops.current.splice(0)) stop();
      },
    };
  });
  const onLoad = useCallback(() => {
    telemetry.loaded++;
    setReady(true);
  }, []);
  const onMeasurement = useCallback((info) => {
    telemetry.measurements.push({
      ...stamp(),
      index: info.index,
      ordinal: info.itemData.ordinal,
      previous: info.previous,
      size: info.size,
      pendingRequests: pendingRequests.current,
    });
  }, []);
  const onScroll = useCallback((event) => {
    const offset = event.nativeEvent?.contentOffset?.y;
    if (typeof offset === "number") telemetry.scrolls.push({ ...stamp(), offset });
  }, []);
  return React.createElement(
    "div",
    { className: "shell" },
    React.createElement(
      "div",
      { ref: setContainer, className: `timeline-holder ${narrow ? "narrow" : "restored"}` },
      React.createElement(LegendList, {
        ref: list,
        data: rows,
        dataVersion: "fixed-offset-conveyor",
        extraData: rows.length,
        keyExtractor,
        getItemType,
        renderItem,
        estimatedItemSize: 90,
        initialScrollAtEnd: false,
        maintainScrollAtEnd: false,
        maintainVisibleContentPosition: findActive
          ? legacyPolicy
            ? false
            : TIMELINE_FIND_VISIBLE_CONTENT_POSITION
          : readingMaintenance,
        onLoad,
        onScroll,
        onItemSizeChanged: onMeasurement,
        className: "timeline",
      }),
      actualNavigation
        ? React.createElement(FindNavigation, {
            container,
            query: findActive ? "synthetic navigation beacon" : "",
            match,
            navigationId: findActive ? 1 : 0,
            rowIndex: rows.findIndex((item) => item.id === targetKey),
            entries: rows,
            listRef: list,
            contentInsetEndAdjustment: 0,
            listReady: ready,
            historyControls,
          })
        : null,
    ),
    React.createElement(
      "aside",
      { className: narrow ? "pane" : "pane closed" },
      "The other panel owns the remaining width.",
    ),
  );
}

createRoot(document.getElementById("root"), {
  onUncaughtError: recordError,
  onCaughtError: recordError,
}).render(
  React.createElement(
    ErrorBoundary,
    null,
    React.createElement(
      Profiler,
      {
        id: "conveyor-reduction",
        onRender: (_id, phase, _duration, _base, _start, commitTime) => {
          telemetry.commits.push({
            ...stamp(),
            commitTime,
            phase: phase === "mount" ? 0 : phase === "nested-update" ? 2 : 1,
          });
        },
      },
      parameters.get("control") === "depth"
        ? React.createElement(DepthControl)
        : React.createElement(App),
    ),
  ),
);
