import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";

/** The drawer's tabs, left to right in dependency order. */
export const RUN_CONTEXT_TABS = ["host", "workspace", "branch"] as const;
export type RunContextTab = (typeof RUN_CONTEXT_TABS)[number];

export interface RunContextTabAvailability {
  /** The tab renders at all. */
  visible: boolean;
  /** The tab takes keyboard focus. A visible read-only tab is skipped. */
  editable: boolean;
}

export type RunContextTabAvailabilityMap = Record<RunContextTab, RunContextTabAvailability>;

/** The tabs the keyboard can land on, in display order. */
export function resolveNavigableRunContextTabs(
  availability: RunContextTabAvailabilityMap,
): RunContextTab[] {
  return RUN_CONTEXT_TABS.filter((tab) => availability[tab].visible && availability[tab].editable);
}

/**
 * The tab the drawer opens on. A requested tab wins when the keyboard can land
 * on it; otherwise the first editable tab, so a started thread opens on its
 * branch. Null means nothing in the drawer can change.
 */
export function resolveInitialRunContextTab(
  navigableTabs: readonly RunContextTab[],
  requestedTab: RunContextTab | null,
): RunContextTab | null {
  if (requestedTab !== null && navigableTabs.includes(requestedTab)) return requestedTab;
  return navigableTabs[0] ?? null;
}

/**
 * Move between tabs. Tab wraps, the way Tab cycles the model picker's provider
 * tabs; the arrow keys stop at the ends.
 */
export function stepRunContextTab(input: {
  navigableTabs: readonly RunContextTab[];
  currentTab: RunContextTab;
  delta: 1 | -1;
  wrap: boolean;
}): RunContextTab {
  const { navigableTabs, currentTab, delta, wrap } = input;
  const currentIndex = navigableTabs.indexOf(currentTab);
  if (currentIndex === -1) return navigableTabs[0] ?? currentTab;
  const nextIndex = currentIndex + delta;
  if (nextIndex >= 0 && nextIndex < navigableTabs.length) return navigableTabs[nextIndex]!;
  if (!wrap) return currentTab;
  return navigableTabs[(nextIndex + navigableTabs.length) % navigableTabs.length]!;
}

/**
 * The machine after the current one, wrapping. Automatic routing is not part
 * of the cycle: it is a drawer choice only. From automatic routing the cycle
 * starts at the first machine.
 */
export function resolveCycledEnvironmentId(input: {
  environmentIds: readonly EnvironmentId[];
  currentEnvironmentId: EnvironmentId;
  automatic: boolean;
  delta: 1 | -1;
}): EnvironmentId | null {
  const { environmentIds, currentEnvironmentId, automatic, delta } = input;
  if (environmentIds.length === 0) return null;
  const currentIndex = automatic ? -1 : environmentIds.indexOf(currentEnvironmentId);
  if (currentIndex === -1) return environmentIds[0]!;
  const nextIndex = (currentIndex + delta + environmentIds.length) % environmentIds.length;
  return environmentIds[nextIndex]!;
}

/** The quick toggle flips between the current checkout and a new worktree. */
export function resolveToggledEnvMode(mode: EnvMode): EnvMode {
  return mode === "worktree" ? "local" : "worktree";
}

/**
 * The option after the selected one in a tab's list, without wrapping, so a
 * held arrow key stops at the end instead of spinning through the list.
 */
export function stepOptionSelection<Value>(input: {
  values: readonly Value[];
  selected: Value | null;
  delta: 1 | -1;
}): Value | null {
  const { values, selected, delta } = input;
  if (values.length === 0) return null;
  const currentIndex = selected === null ? -1 : values.indexOf(selected);
  if (currentIndex === -1) return delta === 1 ? values[0]! : values[values.length - 1]!;
  const nextIndex = Math.min(values.length - 1, Math.max(0, currentIndex + delta));
  return values[nextIndex]!;
}

/** Digits 1–9 pick an option in the active tab directly. */
export function resolveDigitOptionIndex(key: string): number | null {
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return Number(key) - 1;
}

/**
 * Whether a host belongs in the Host tab and the host cycle: connected, or on
 * its first connection attempt. `reconnecting` only follows a failed attempt
 * (see presentConnectionState in client-runtime), and a stopped server stays
 * there indefinitely while the client retries, so it counts as unreachable,
 * as do `error`, `offline` and `available` (saved but not connecting).
 * Unknown stays. The draft's current host is still named by the tab.
 */
export function isRunContextHostReachable(
  phase: EnvironmentConnectionPhase | undefined,
): boolean | undefined {
  if (phase === undefined) return undefined;
  return phase === "connected" || phase === "connecting";
}

/**
 * The hosts the drawer offers and the cycle visits: reachable ones only. An
 * unreachable current host is not offered either, so neither a key nor the
 * cycle can pin a draft to it; the Host tab still names it as its summary.
 */
export function resolveRunContextHosts(
  environments: readonly EnvironmentOption[],
): EnvironmentOption[] {
  return environments.filter((environment) => environment.reachable !== false);
}

/**
 * What a tab-specific shortcut does: open the drawer on that tab, move an
 * open drawer to it, or close the drawer when it already shows that tab.
 * `null` is the drawer's own toggle, which always closes an open drawer.
 */
export function resolveRunContextTabRequest(input: {
  drawerOpen: boolean;
  activeTab: RunContextTab | null;
  requestedTab: RunContextTab | null;
  navigableTabs: readonly RunContextTab[];
}):
  | { kind: "open"; tab: RunContextTab | null }
  | { kind: "switch"; tab: RunContextTab }
  | { kind: "close" } {
  const { drawerOpen, activeTab, requestedTab, navigableTabs } = input;
  const target = resolveInitialRunContextTab(navigableTabs, requestedTab);
  if (!drawerOpen) return { kind: "open", tab: target };
  if (requestedTab === null || target === null || target === activeTab) return { kind: "close" };
  return { kind: "switch", tab: target };
}
