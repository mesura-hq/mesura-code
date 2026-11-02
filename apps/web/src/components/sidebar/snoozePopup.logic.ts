import type { SnoozePreset } from "../Sidebar.snooze";

export type SnoozePopupRow =
  | { readonly kind: "wake"; readonly hint: "w"; readonly label: "Wake now" }
  | {
      readonly kind: "preset";
      readonly hint: string;
      readonly label: string;
      readonly preset: SnoozePreset;
    }
  | { readonly kind: "custom"; readonly hint: "c"; readonly label: "Custom…" };

/** Presets arrive resolved by upstream, including its order and when-labels. */
export function snoozePopupRows(
  presets: ReadonlyArray<SnoozePreset>,
  snoozed: boolean,
): ReadonlyArray<SnoozePopupRow> {
  return [
    ...(snoozed ? [{ kind: "wake", hint: "w", label: "Wake now" } as const] : []),
    ...presets.map((preset, index): SnoozePopupRow => ({
      kind: "preset",
      hint: String(index + 1),
      label: preset.label,
      preset,
    })),
    { kind: "custom", hint: "c", label: "Custom…" },
  ];
}

export function moveSnoozeHighlight(index: number, delta: number, count: number): number {
  return count === 0 ? 0 : (index + delta + count) % count;
}
