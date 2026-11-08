import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RightPanelSheet } from "@mesura/right-panel-sheet";
import {
  activatePanelSurfaceFromLauncher,
  isPanelSurfaceKeyboardActivation,
  focusPanelSurfaceAfterRender,
  usePanelSurfaceKeys,
} from "@mesura/panel-surface-focus";

// This fixture uses the real sheet and shared handoff, not the application's
// provider/store boundary. RightPanelTabs wiring is pinned by its focused suite.
const parameters = new URLSearchParams(location.search);
const legacy = parameters.get("policy") === "legacy";
const inline = parameters.get("mode") === "inline";
const lazy = parameters.get("entry") === "lazy";
const retained = parameters.get("retained") === "1";
const telemetry = (window.telemetry = {
  events: [],
  errors: [],
  ready: 0,
  lazyEntry: {
    parkedTitleTime: null,
    parkedTitleToken: 0,
    releaseTime: null,
    pointerdowns: [],
  },
});
const identity = new WeakMap();
let nextIdentity = 1;
function token(element) {
  if (!element) return 0;
  if (!identity.has(element)) identity.set(element, nextIdentity++);
  return identity.get(element);
}
function focusCode(element) {
  if (element === document.body) return 0;
  if (element?.matches('[data-slot="sheet-popup"]')) return 1;
  if (element?.matches("[data-right-panel-surface-content]")) return 2;
  if (element?.matches('[aria-label="Open a surface"]')) return 3;
  if (element?.matches("[data-title]")) return 4;
  if (element?.matches('[role="tree"]')) return 5;
  if (element?.matches("[data-user-target]")) return 6;
  return 7;
}
function waitingTitle() {
  if (
    !lazy ||
    document.querySelector('[role="tree"]') ||
    document.querySelector('[aria-label="Open a surface"]')
  )
    return null;
  return document.querySelector("[data-active-tab] [data-title]");
}
document.addEventListener("focusin", (event) => {
  const time = performance.now();
  telemetry.events.push({ time, focus: focusCode(document.activeElement) });
  const title = waitingTitle();
  // Record the first parked transition. A touch that retains focus must not reset its deadline.
  if (title && event.target === title && telemetry.lazyEntry.parkedTitleTime === null) {
    telemetry.lazyEntry.parkedTitleTime = time;
    telemetry.lazyEntry.parkedTitleToken = token(title);
  }
});
document.addEventListener("focusout", () => {
  telemetry.events.push({ time: performance.now(), focus: focusCode(document.activeElement) });
});
document.addEventListener(
  "pointerdown",
  (event) => {
    const title = waitingTitle();
    const input = {
      time: performance.now(),
      isTrusted: event.isTrusted,
      pointerType: event.pointerType,
      targetIsWaitingTitle: title !== null && event.target === title,
      targetToken: token(event.target),
      focus: focusCode(document.activeElement),
      // Read after tap completes, when evidence is serialized, so later listeners remain observable.
      get defaultPrevented() {
        return event.defaultPrevented;
      },
    };
    telemetry.lazyEntry.pointerdowns.push(input);
  },
  { capture: true, passive: true },
);
window.addEventListener("error", (event) =>
  telemetry.errors.push(String(event.error ?? event.message)),
);
window.addEventListener("unhandledrejection", (event) =>
  telemetry.errors.push(String(event.reason)),
);

function FilesTree() {
  const [selected, setSelected] = useState(0);
  return React.createElement(
    "div",
    {
      role: "tree",
      "aria-label": "Synthetic Files",
      "aria-activedescendant": `synthetic-file-${selected}`,
      "data-pane-entry": "1",
      tabIndex: -1,
      onKeyDown: (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelected(event.key === "ArrowDown" ? 1 : 0);
        }
      },
    },
    [0, 1].map((index) =>
      React.createElement(
        "div",
        {
          key: index,
          id: `synthetic-file-${index}`,
          role: "treeitem",
          "aria-selected": selected === index,
        },
        `Synthetic file ${index + 1}`,
      ),
    ),
  );
}

function Panel() {
  const panelRef = useRef(null);
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState(retained);
  const [launcher, setLauncher] = useState(true);
  const [ready, setReady] = useState(!lazy);
  const [highlight, setHighlight] = useState(false);
  usePanelSurfaceKeys(panelRef, created ? "synthetic-files" : null);
  const focusLauncher = useCallback((node) => node?.focus({ preventScroll: true }), []);
  const selectFiles = (keyboard) => {
    const panel = panelRef.current;
    const activate = () => {
      setLauncher(false);
      setCreated(true);
    };
    if (legacy) {
      const title = panel.querySelector("[data-title]");
      activate();
      // The old selection removes the focused launcher before any focus handoff.
      focusPanelSurfaceAfterRender(panel, title);
    } else activatePanelSurfaceFromLauncher(panel, activate, keyboard);
  };
  useLayoutEffect(() => {
    telemetry.ready = 1;
    window.fixture = {
      makeReady: () => {
        telemetry.lazyEntry.releaseTime = performance.now();
        setReady(true);
      },
      openLauncher: () => setLauncher(true),
      close: () => setOpen(false),
      snapshot() {
        const panel = panelRef.current;
        const content = panel?.querySelector("[data-right-panel-surface-content]");
        const tree = panel?.querySelector('[role="tree"]');
        const rect = tree?.getBoundingClientRect();
        return {
          focus: focusCode(document.activeElement),
          editable: Number(
            document.activeElement?.isContentEditable ||
              /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? ""),
          ),
          focusInOwner: Number(panel?.contains(document.activeElement)),
          contentToken: token(content),
          contentTabIndex: content?.tabIndex ?? -2,
          treeToken: token(tree),
          treeCount: panel?.querySelectorAll('[role="tree"]').length ?? 0,
          tabCount: panel?.querySelectorAll("[data-active-tab]").length ?? 0,
          launcherCount: panel?.querySelectorAll('[aria-label="Open a surface"]').length ?? 0,
          selected: tree?.getAttribute("aria-activedescendant") === "synthetic-file-1" ? 1 : 0,
          treeWidth: rect?.width ?? 0,
          treeHeight: rect?.height ?? 0,
          open: Number(open),
          errors: telemetry.errors.length,
        };
      },
    };
  });
  const content = React.createElement(
    "div",
    { ref: panelRef, "data-preview-panel-mode": inline ? "inline" : "sheet" },
    React.createElement("button", { "data-user-target": "", type: "button" }, "User focus target"),
    React.createElement(
      "div",
      { "data-right-panel-tabbar": "" },
      created &&
        React.createElement(
          "div",
          { "data-active-tab": "true" },
          React.createElement("button", { "data-title": "", type: "button" }, "Files"),
        ),
    ),
    // This node is unkeyed and stays mounted when the launcher disappears.
    React.createElement(
      "div",
      { "data-right-panel-surface-content": "" },
      created &&
        (ready
          ? React.createElement(FilesTree)
          : React.createElement("p", null, "Loading synthetic Files")),
      launcher &&
        React.createElement(
          "div",
          {
            ref: focusLauncher,
            tabIndex: 0,
            "aria-label": "Open a surface",
            onKeyDown: (event) => {
              if (event.key.toLowerCase() === "f") {
                event.preventDefault();
                selectFiles(true);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight(true);
              } else if (
                event.key === "Enter" &&
                event.target === event.currentTarget &&
                highlight
              ) {
                event.preventDefault();
                selectFiles(true);
              }
            },
          },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: (event) => selectFiles(isPanelSurfaceKeyboardActivation(event)),
            },
            "Files",
          ),
        ),
    ),
  );
  return inline
    ? content
    : React.createElement(
        RightPanelSheet,
        { animationDurationMs: 0, open, onClose: () => setOpen(false) },
        content,
      );
}

createRoot(document.getElementById("root")).render(React.createElement(Panel));
