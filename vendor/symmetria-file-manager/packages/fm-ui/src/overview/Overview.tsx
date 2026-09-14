import { type ReactNode, useRef } from "react";
import { DirectoryScope, snapshotStatus } from "../directory/DirectoryScope.tsx";
import { useDialogFocus } from "../hooks/useDialogFocus.ts";
import { ConnectedGroups } from "./ConnectedGroups.tsx";
import type { useOverview } from "./useOverview.ts";
import type { OverviewPort } from "./useOverviewMode.ts";
import "./overview.css";

function Overview({
  root,
  model,
  onClose,
  port,
  minimapVisible,
  onToggleMinimap,
}: {
  readonly root: string;
  readonly model: ReturnType<typeof useOverview>;
  readonly onClose: () => void;
  readonly port: OverviewPort;
  readonly minimapVisible: boolean;
  readonly onToggleMinimap: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="Folder overview"
      data-root={root}
      tabIndex={-1}
      className="overview"
      onKeyDownCapture={(event) => {
        if (
          event.key !== "Escape" ||
          panel.current?.querySelector("[data-flash-active]") ||
          (event.target instanceof Element && event.target.closest("input,textarea,select"))
        )
          return;
        const opened = panel.current?.querySelector("details[open]");
        if (opened) {
          opened.removeAttribute("open");
          event.preventDefault();
          event.stopPropagation();
          panel.current?.focus();
        }
      }}
    >
      <ConnectedGroups
        root={root}
        model={model}
        port={port}
        minimapVisible={minimapVisible}
        onToggleMinimap={onToggleMinimap}
        renderToolbar={(controls) => (
          <OverviewToolbar model={model} onClose={onClose}>
            {controls}
          </OverviewToolbar>
        )}
      />
    </div>
  );
}

function OverviewToolbar({
  model,
  onClose,
  children,
}: {
  readonly model: ReturnType<typeof useOverview>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <header className="overview-toolbar">
      <strong>Folder overview</strong>
      <span title={snapshotStatus(model)}>{snapshotStatus(model)}</span>
      {model.coverage?.size ? (
        <button type="button" aria-label="Refresh overview" onClick={model.refresh}>
          Retry
        </button>
      ) : null}
      <DirectoryScope model={model} />
      {children}
      <button type="button" onClick={onClose}>
        Close · Esc
      </button>
    </header>
  );
}

export function OverviewLayer({
  root,
  model,
  onClose,
  port,
  minimapVisible,
  onToggleMinimap,
}: {
  readonly root: string | null;
  readonly model: ReturnType<typeof useOverview>;
  readonly onClose: () => void;
  readonly port: OverviewPort;
  readonly minimapVisible: boolean;
  readonly onToggleMinimap: () => void;
}) {
  return root === null ? null : (
    <Overview
      key={root}
      root={root}
      model={model}
      onClose={onClose}
      port={port}
      minimapVisible={minimapVisible}
      onToggleMinimap={onToggleMinimap}
    />
  );
}
