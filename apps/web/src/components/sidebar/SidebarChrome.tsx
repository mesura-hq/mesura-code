import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  CircleDotIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments, usePullRequestsSupported } from "../../state/environments";
import { parseIssueSearch, someEnvironmentHasIssues } from "../issues/issues.logic";
import { MesuraWordmark } from "../MesuraWordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { AccountLimitsDock, useAccountLimitsPanelController } from "./AccountLimitsPanel";
import { HostsDock } from "./HostsPanel";
import { useSidebarDockController } from "./sidebarDockController";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:pl-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        // Over the stage artwork: the media viewer's control-on-imagery treatment.
        variant={backdropVariant ? "media-navigation" : "ghost"}
        className="relative top-auto z-10 translate-y-0 md:hidden"
      />
      {/* One visible line: the pill wraps onto the clipped second line once it no longer fits.
          The padding keeps the brand's focus ring inside the clip. */}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

// Measures the brand at its titlebar inset, plus the header's right padding and the
// sidebar border, so the sidebar minimum follows font size, zoom and macOS window controls.
export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      return observeResize(probe, ([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
    },
    [onWidthChange],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    // Center the visible capitals, without the font's ascender/descender space.
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <MesuraWordmark className="h-[1cap] w-auto shrink-0" />
      <span
        className={cn(
          "truncate [text-box:trim-both_cap_alphabetic]",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  onPointerEnter,
  onPointerLeave,
  suppressTooltip = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  suppressTooltip?: boolean;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip disabled={suppressTooltip}>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={onClick}
              onPointerEnter={onPointerEnter}
              onPointerLeave={onPointerLeave}
              size="icon"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  // The dock takes sidebar height, so it only exists where the Usage entry that
  // opens it does. On a settings or usage page the row shows Back instead, and
  // a keyboard-only panel there would have no way to say it was there.
  const accountLimitsEnabled = !isMobile && !isOnUtilityPage;
  const accountLimitsController = useAccountLimitsPanelController(accountLimitsEnabled);
  // Fork: the Hosts dock shares the usage dock's gate and its controller.
  const hostsController = useSidebarDockController({
    dock: "hosts",
    command: "hosts.peek",
    enabled: accountLimitsEnabled,
  });
  const pullRequestsSupported = usePullRequestsSupported();
  // Mesura: the Issues entry shows once any connected server can list issues.
  const { environments } = useEnvironments();
  const issuesSupported = someEnvironmentHasIssues(environments);
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    accountLimitsController.close();
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [accountLimitsController, isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    // The dock and the row it opens from share a column of their own rather
    // than being two items of the footer's. The footer sets `gap-2`, and a gap
    // is drawn between adjacent items whatever their size — so a collapsed dock
    // sitting directly in it would hold eight pixels open for ever. Nested,
    // the dock contributes nothing while closed and its lower rule lands
    // against the row while open, which is the delimiter doing its job.
    //
    // ACCEPTED MERGE COST. This wrapper re-indents the whole return block of
    // an upstream component. Six upstream commits in the last six months
    // touched this exact block, so expect roughly one whitespace conflict a
    // month here, each resolved by taking upstream's line and re-indenting it.
    // The cheaper shape — dock in `SidebarChromeFooter`, controller passed
    // down — was measured and rejected: the utility-page gate is computed here,
    // so the footer would need its own copy of the route test, and two copies
    // of a gate drift. A recurring whitespace conflict is the smaller cost.
    <div className="flex flex-col">
      {accountLimitsEnabled ? <AccountLimitsDock controller={accountLimitsController} /> : null}
      {accountLimitsEnabled ? <HostsDock controller={hostsController} /> : null}
      <SidebarMenu className="flex-row items-center">
        {isOnUtilityPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarUtilityItem
              icon={<SettingsIcon />}
              label="Settings"
              onClick={handleSettingsClick}
            />
            {pullRequestsSupported ? (
              <SidebarUtilityItem
                icon={<PullRequestGlyph.pullRequest />}
                label="Pull Requests"
                onClick={handlePullRequestsClick}
              />
            ) : null}
            {issuesSupported ? (
              <SidebarUtilityItem
                icon={<CircleDotIcon />}
                label="Issues"
                onClick={() => {
                  closeMobileSidebar();
                  void navigate({ to: "/issues", search: parseIssueSearch({}) });
                }}
              />
            ) : null}
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label="Usage"
              onClick={handleUsageClick}
              onPointerEnter={accountLimitsController.onPointerEnter}
              onPointerLeave={accountLimitsController.onPointerLeave}
              suppressTooltip={accountLimitsController.open}
            />
            <SidebarUtilityItem
              icon={<ServerIcon />}
              label="Hosts"
              onClick={hostsController.togglePinned}
              onPointerEnter={hostsController.onPointerEnter}
              onPointerLeave={hostsController.onPointerLeave}
              suppressTooltip={hostsController.open}
            />
          </>
        )}
        <SidebarUpdatePill />
      </SidebarMenu>
    </div>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
