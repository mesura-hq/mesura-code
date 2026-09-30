import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { formatRelativeTimeLabel } from "../timestampFormat";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export function sidebarThreadTimeLabel(thread: EnvironmentThreadShell): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

export function compactSettledSidebarTimeLabel(timestamp: string | null): string {
  return timestamp === null ? "" : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

/** The sidebar card layout also holds a search result and its explanation. */
export function SidebarThreadCardContent(props: {
  readonly children: ReactNode;
  readonly surface?: "sidebar" | "search";
}) {
  return (
    <div
      className={cn(
        "relative z-10 min-w-0",
        props.surface === "search"
          ? "w-full px-3 py-2.5"
          : "h-[4.875rem] px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]",
      )}
    >
      {props.children}
    </div>
  );
}

export function SidebarThreadCardHeader(props: { readonly children: ReactNode }) {
  return <div className="flex h-5 min-w-0 items-center gap-1.5">{props.children}</div>;
}

export function SidebarThreadCardProject(props: {
  readonly project: ProjectFaviconProject | null;
  readonly label: string | null;
  readonly labelClassName?: string;
}) {
  return (
    <>
      {props.project ? (
        <ProjectFavicon project={props.project} className="size-4 shrink-0" />
      ) : null}
      {props.label ? (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-secondary-label text-xs",
            props.labelClassName ?? "font-medium",
          )}
        >
          {props.label}
        </span>
      ) : (
        <span className="flex-1" />
      )}
    </>
  );
}

export function SidebarThreadCardTitle(props: { readonly children: ReactNode }) {
  return <div className="mt-1 flex min-w-0">{props.children}</div>;
}

export function SidebarThreadCardFooter(props: { readonly children: ReactNode }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
      {props.children}
    </div>
  );
}

export function SidebarThreadCardReason(props: { readonly children: ReactNode }) {
  return (
    <p className="mt-2 border-t border-border/50 pt-2 text-xs text-secondary-label">
      {props.children}
    </p>
  );
}
