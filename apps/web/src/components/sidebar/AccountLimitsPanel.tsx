import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import {
  useAccountLimits,
  type AccountLimitsRow,
  type AccountLimitsView,
} from "../../state/accountLimits";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Popover, PopoverPopup } from "../ui/popover";
import {
  closeHeldUsagePeek,
  createUsagePeekHoverBridge,
  createUsagePeekKeyboardLifecycle,
  INITIAL_USAGE_PEEK_STATE,
  isKeybindingCaptureTarget,
  type UsagePeekKeyboardEvent,
  type UsagePeekHoverBridge,
  type UsagePeekKeyboardLifecycle,
  type UsagePeekState,
} from "./AccountLimitsPanel.logic";

const HOVER_BRIDGE_DELAY_MS = 120;
export const ACCOUNT_LIMITS_POPOVER_FOCUS_PROPS = {
  initialFocus: false,
  finalFocus: false,
} as const;

export interface AccountLimitsPanelController {
  readonly open: boolean;
  readonly shortcutLabel: string | null;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly close: () => void;
}

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export function useAccountLimitsPanelController(enabled: boolean): AccountLimitsPanelController {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [hovered, setHovered] = useState(false);
  const [peek, setPeek] = useState<UsagePeekState>(INITIAL_USAGE_PEEK_STATE);
  const keyboardLifecycleRef = useRef<UsagePeekKeyboardLifecycle | null>(null);
  const hoverBridgeRef = useRef<UsagePeekHoverBridge | null>(null);
  if (hoverBridgeRef.current === null) {
    hoverBridgeRef.current = createUsagePeekHoverBridge({
      delayMs: HOVER_BRIDGE_DELAY_MS,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onHoverChange: setHovered,
    });
  }

  const onPointerEnter = useCallback(() => hoverBridgeRef.current?.enter(), []);
  const onPointerLeave = useCallback(() => hoverBridgeRef.current?.leave(), []);
  const closePanel = useCallback(() => {
    hoverBridgeRef.current?.dispose();
    if (keyboardLifecycleRef.current) {
      keyboardLifecycleRef.current.close();
    } else {
      setPeek(closeHeldUsagePeek());
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const platform = navigator.platform;
    const lifecycle = createUsagePeekKeyboardLifecycle({
      keybindings,
      platform,
      getContext: () => ({ terminalFocus: isTerminalFocused() }),
      onStateChange: setPeek,
    });
    keyboardLifecycleRef.current = lifecycle;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isKeybindingCaptureTarget(event.target)) return;
      const transition = lifecycle.keyDown(event as UsagePeekKeyboardEvent);
      if (transition.handled) consumeKeyboardEvent(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const transition = lifecycle.keyUp(event as UsagePeekKeyboardEvent);
      if (transition.handled) consumeKeyboardEvent(event);
    };
    const onVisibilityChange = () => {
      lifecycle.visibilityChange(document.visibilityState === "visible");
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", lifecycle.close);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", lifecycle.close);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      lifecycle.dispose();
      if (keyboardLifecycleRef.current === lifecycle) keyboardLifecycleRef.current = null;
    };
  }, [enabled, keybindings]);

  useEffect(
    () => () => {
      hoverBridgeRef.current?.dispose();
    },
    [],
  );

  return {
    open: enabled && (hovered || peek.held),
    shortcutLabel: shortcutLabelForCommand(keybindings, "usage.peek"),
    onPointerEnter,
    onPointerLeave,
    close: closePanel,
  };
}

function formatCompactDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "less than 1m";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  return `${minutes}m`;
}

function resetLabel(resetsAt: string | null, environmentNowMs: number | null): string | null {
  if (resetsAt === null || environmentNowMs === null) return null;
  const resetAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetAtMs)) return null;
  const remaining = resetAtMs - environmentNowMs;
  return remaining <= 0 ? "Reset due" : `Resets in ${formatCompactDuration(remaining)}`;
}

function readingAgeLabel(readingAgeMs: number | null): string | null {
  if (readingAgeMs === null) return null;
  if (readingAgeMs < 60_000) return "Updated just now";
  return `Updated ${formatCompactDuration(readingAgeMs)} ago`;
}

function AccountLimitRowView(props: { row: AccountLimitsRow }) {
  const { row } = props;
  const ageLabel = readingAgeLabel(row.readingAgeMs);
  return (
    <section className="border-border/60 border-t px-3 py-3 [&:first-of-type]:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          accentColor={row.accentColor}
          className="size-5"
          displayName={row.accountLabel}
          driverKind={row.driver}
          iconClassName="size-4 text-foreground/80"
          showBadge={Boolean(row.accentColor)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{row.accountLabel}</span>
            {row.plan ? (
              <span className="truncate font-mono text-[10px] text-muted-foreground/65">
                {row.plan}
              </span>
            ) : null}
          </div>
          {row.subtitle ? (
            <div className="truncate text-[10px] text-muted-foreground/60">{row.subtitle}</div>
          ) : null}
        </div>
        {ageLabel ? (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/55">
            {ageLabel.replace("Updated ", "")}
          </span>
        ) : null}
      </div>

      {row.windows.length > 0 ? (
        <div className="mt-2.5 space-y-2.5">
          {row.windows.map((rowWindow) => {
            const { window } = rowWindow;
            const usedPercent = Math.round(window.usedPercent);
            const reset = resetLabel(window.resetsAt, rowWindow.environmentNowMs);
            return (
              <div key={`${window.meter?.id ?? "primary"}:${window.id}`}>
                <div className="mb-1 flex items-baseline justify-between gap-3 font-mono text-[10px]">
                  <span className="text-muted-foreground">{window.label}</span>
                  <span className="tabular-nums text-foreground/75">{usedPercent}%</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-foreground/8">
                  <div
                    className="h-full rounded-full bg-foreground/45"
                    style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
                  />
                </div>
                {reset ? (
                  <div className="mt-1 text-right font-mono text-[9px] text-muted-foreground/50">
                    {reset}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {row.state === "missing" ? "No reading yet" : "No visible limits reported"}
        </div>
      )}

      {row.state === "stale" || row.state === "stale-refresh-failed" ? (
        <div className="mt-2 text-[10px] text-muted-foreground/65">Reading may be stale</div>
      ) : null}
      {row.state === "refresh-failed" || row.state === "stale-refresh-failed" ? (
        <div className="mt-1 text-[10px] text-muted-foreground/65">
          Refresh failed{row.windows.length > 0 ? " · showing the last reading" : ""}
        </div>
      ) : null}
    </section>
  );
}

export function AccountLimitsPanelContent(props: {
  readonly view: AccountLimitsView;
  readonly shortcutLabel: string | null;
}) {
  const { view, shortcutLabel } = props;
  const disconnected = view.environments.filter(
    (environment) => environment.state !== "ready" && environment.state !== "pending",
  );
  const emptyMessage = view.environments.some(
    (environment) => environment.state === "unsupported-contract",
  )
    ? "Update the environment to view limits"
    : view.environments.some((environment) => environment.state === "disconnected")
      ? "Environment disconnected"
      : view.environments.some((environment) => environment.state === "error")
        ? "Could not load account limits"
        : "No account limits available";
  return (
    <div className="w-[21rem] max-w-[calc(100vw-1rem)]" aria-label="Usage limits">
      <header className="flex items-center justify-between gap-3 border-border/60 border-b px-3 py-2.5">
        <div>
          <div className="text-xs font-medium text-foreground">Usage limits</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground/60">Subscription windows</div>
        </div>
        {shortcutLabel ? (
          <kbd className="rounded border border-border/70 bg-muted/45 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
            {shortcutLabel}
          </kbd>
        ) : null}
      </header>

      {view.isPending ? (
        <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">
          Checking limits…
        </div>
      ) : view.rows.length === 0 ? (
        <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        view.rows.map((row) => <AccountLimitRowView key={row.key} row={row} />)
      )}

      {view.isPartial || disconnected.length > 0 ? (
        <footer className="border-border/60 border-t px-3 py-2 text-[9px] text-muted-foreground/55">
          Some environments are unavailable
        </footer>
      ) : null}
    </div>
  );
}

export function AccountLimitsPopover(props: {
  readonly anchor: HTMLElement | null;
  readonly controller: AccountLimitsPanelController;
}) {
  const { anchor, controller } = props;
  const view = useAccountLimits();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (controller.open && !wasOpen.current) view.refresh();
    wasOpen.current = controller.open;
  }, [controller.open, view.refresh]);

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
      open={controller.open && anchor !== null}
    >
      <PopoverPopup
        aria-label="Usage limits"
        align="start"
        anchor={anchor}
        className="p-0 [background:color-mix(in_srgb,var(--popover)_70%,var(--background))]! [-webkit-backdrop-filter:none]! [backdrop-filter:none]!"
        {...ACCOUNT_LIMITS_POPOVER_FOCUS_PROPS}
        onPointerEnter={controller.onPointerEnter}
        onPointerLeave={controller.onPointerLeave}
        side="top"
        sideOffset={8}
        viewportClassName="p-0"
      >
        <AccountLimitsPanelContent shortcutLabel={controller.shortcutLabel} view={view} />
      </PopoverPopup>
    </Popover>
  );
}
