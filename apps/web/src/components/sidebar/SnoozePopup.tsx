import { useRouter } from "@tanstack/react-router";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { getCommandPaletteReturnFocus } from "../../commandPaletteStore";
import { registerCommandsWithLeaderKeys } from "../../commands/commandRegistry";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readEnvironmentServerConfigLoaded, readThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../../threadRoutes";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPopup,
  DialogPanel,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSidebar } from "../ui/sidebar";
import { cancelPendingSnoozes, snoozeAndAdvance } from "./snoozeAndAdvance";
import { moveSnoozeHighlight, snoozePopupRows, type SnoozePopupRow } from "./snoozePopup.logic";

interface SnoozeRequest {
  readonly target: ScopedThreadRef;
  readonly origin: HTMLElement | null;
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly snoozed: boolean;
}

function commandOrigin(): HTMLElement | null {
  const active = document.activeElement;
  // The palette closes before running its action, but its input still has focus in this commit.
  if (active?.closest("[data-command-palette]")) {
    const origin = getCommandPaletteReturnFocus();
    return origin instanceof HTMLElement ? origin : null;
  }
  return active instanceof HTMLElement ? active : null;
}

async function reportAction(
  pending: Promise<AtomCommandResult<unknown, unknown>>,
  title: string,
): Promise<void> {
  const result = await pending;
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Outside the phone drawer: its closed sheet unmounts the sidebar and its row handlers. */
export function SnoozeCommandHost() {
  const router = useRouter();
  const { unsnoozeThread } = useThreadActions();
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [request, setRequest] = useState<SnoozeRequest | null>(null);
  // Keep the row owner's in-flight guard and forward navigation; a direct mutation bypasses both.
  const snooze = (target: ScopedThreadRef, choice: Pick<SnoozePreset, "snoozedUntil">) => {
    if (!snoozeAndAdvance(target, choice)) (isMobile ? setOpenMobile : setOpen)(true);
  };
  const wake = (target: ScopedThreadRef) => {
    void reportAction(unsnoozeThread(target), "Failed to wake thread");
  };

  const run = useStableCallback((wakeOnly: boolean) => {
    const origin = commandOrigin();
    const focusedRow = origin?.closest<HTMLElement>("[data-mesura-thread-key]");
    const routeTarget = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const draft =
      routeTarget?.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
        : null;
    const target = focusedRow?.closest('[role="tree"]')
      ? parseScopedThreadKey(focusedRow.dataset.mesuraThreadKey ?? "")
      : resolveActiveThreadRouteRef(routeTarget, draft);
    const thread = target && readThreadShell(target);
    let reason: string | null = null;
    if (!thread || !target || thread.deletedAt !== null || thread.archivedAt !== null) {
      reason = "No target thread. Open a thread or focus a thread in the sidebar.";
    } else if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) {
      reason = "This connection cannot change the target thread.";
    } else if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      reason = "Snooze is unavailable until the thread’s environment connects.";
    } else if (!wakeOnly && !canSnooze(thread, { now: new Date().toISOString() })) {
      reason = "Cannot snooze this thread while it has a pending request or queued turn.";
    }
    if (reason || !target || !thread) {
      toastManager.add({
        type: "warning",
        title: wakeOnly ? "Could not wake thread" : "Could not snooze thread",
        description: reason ?? undefined,
      });
      return;
    }
    const now = new Date();
    const snoozed = effectiveSnoozed(thread, { now: now.toISOString() });
    if (wakeOnly) {
      if (snoozed) wake(target);
      else toastManager.add({ title: "Thread is not snoozed" });
      return;
    }
    setRequest({
      target,
      origin,
      snoozed,
      presets: resolveSnoozePresets(now, timestampFormat, target.environmentId),
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers keyboard and palette commands for the app layout, with stable callbacks
  useEffect(() => {
    const unregister = registerCommandsWithLeaderKeys({
      "thread.snooze": (event) => {
        event.preventDefault();
        run(false);
      },
      "thread.unsnooze": (event) => {
        event.preventDefault();
        run(true);
      },
    });
    return () => {
      unregister();
      cancelPendingSnoozes();
    };
  }, [run]);

  if (!request) return null;
  return (
    <SnoozePopup
      request={request}
      onClose={() => setRequest(null)}
      onPick={(row) => {
        if (row.kind === "wake") {
          setRequest(null);
          wake(request.target);
        } else if (row.kind === "custom") {
          setRequest(null);
          void requestCustomSnooze().then((choice) => {
            if (choice) snooze(request.target, choice);
          });
        } else {
          const preset = pickSnoozePreset(
            request.presets,
            row.preset.id,
            timestampFormat,
            request.target.environmentId,
          );
          if (preset) {
            setRequest(null);
            snooze(request.target, preset);
          }
        }
      }}
    />
  );
}

function SnoozePopup(props: {
  readonly request: SnoozeRequest;
  readonly onClose: () => void;
  readonly onPick: (row: SnoozePopupRow) => void;
}) {
  const rows = snoozePopupRows(props.request.presets, props.request.snoozed);
  const [highlight, setHighlight] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (index: number) => {
    setHighlight(index);
    buttons.current[index]?.focus();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        className="sm:max-w-sm"
        initialFocus={() => buttons.current[0]}
        finalFocus={() =>
          props.request.origin === document.body ? false : (props.request.origin ?? false)
        }
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
            return;
          const delta =
            event.key === "j" || event.key === "ArrowDown"
              ? 1
              : event.key === "k" || event.key === "ArrowUp"
                ? -1
                : 0;
          if (delta) {
            event.preventDefault();
            event.stopPropagation();
            move(moveSnoozeHighlight(highlight, delta, rows.length));
          } else {
            const row =
              event.key === "Enter" ? rows[highlight] : rows.find((row) => row.hint === event.key);
            if (row) {
              event.preventDefault();
              event.stopPropagation();
              props.onPick(row);
            }
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Snooze thread</DialogTitle>
          <DialogDescription>Choose when this thread returns to your inbox.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1">
            {rows.map((row, index) => (
              <button
                key={row.hint}
                type="button"
                ref={(button) => {
                  buttons.current[index] = button;
                }}
                tabIndex={highlight === index ? 0 : -1}
                onFocus={() => setHighlight(index)}
                onClick={() => props.onPick(row)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[highlighted=true]:bg-accent"
                data-highlighted={highlight === index}
              >
                <span className="min-w-0 flex-1">{row.label}</span>
                {row.kind === "preset" && (
                  <span className="text-xs text-muted-foreground">{row.preset.whenLabel}</span>
                )}
                <kbd className="min-w-5 rounded border px-1 text-center font-mono text-xs text-muted-foreground">
                  {row.hint}
                </kbd>
              </button>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
