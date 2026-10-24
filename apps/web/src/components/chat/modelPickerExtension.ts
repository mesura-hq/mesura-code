import type { ProviderInstanceId } from "@t3tools/contracts";
import type { KeyboardEvent, ReactNode } from "react";

/**
 * The seam through which the fork's combined picker (`CombinedModelPickerContent`)
 * extends upstream's `ModelPickerContent` without owning its internals. Every
 * field is optional and the picker behaves exactly as upstream ships it when
 * the extension is absent.
 */
export interface ModelPickerExtension {
  /**
   * Hides the model screen and pauses its window shortcuts while another
   * screen (More options) is shown. Search text, provider tab, and highlight
   * survive, because the content stays mounted.
   */
  hidden?: boolean;
  /** Merged into the content root, for example to cap its height. */
  rootClassName?: string;
  /** Changes whenever row accessories must re-render in the virtual list. */
  rowRenderKey?: unknown;
  /** Rendered in a model row before its favorite button. */
  renderRowAccessory?: (row: {
    instanceId: ProviderInstanceId;
    slug: string;
    disabled: boolean;
  }) => ReactNode;
  /** Every highlight change of the model list, with Base UI's reason. */
  onHighlightedModelChange?: (modelKey: string | null, reason: string) => void;
  /**
   * Called after each change to the rows the current provider tab and search
   * show. Keep the callback stable; a new identity re-runs the report.
   */
  onVisibleModelsChange?: (isModelVisible: (modelKey: string) => boolean) => void;
  /**
   * Runs first on every search-field key. Return true when the extension
   * handled the key; the picker then skips its own handling.
   */
  onSearchKeyDown?: (
    event: KeyboardEvent<HTMLInputElement>,
    context: {
      highlightedModelKey: string | null;
      selectAdjacentProvider: (direction: 1 | -1) => void;
    },
  ) => boolean;
}
