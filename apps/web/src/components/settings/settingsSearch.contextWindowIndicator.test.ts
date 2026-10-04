// Entry point: the settings search catalog `SETTINGS_SEARCH_ITEMS` and
// `searchSettings`, the matcher both the settings sidebar search
// (SettingsSidebarNav) and the command palette (CommandPalette) call. The
// rendered row reads its id and title from this entry via `searchableSetting`.
import { describe, expect, it } from "vite-plus/test";

import { searchSettings, SETTINGS_SEARCH_ITEMS, type SettingsSearchItem } from "./settingsSearch";

const CONTEXT_WINDOW_INDICATOR_ID = "context-window-indicator";

function findCatalogItem(id: string): SettingsSearchItem | undefined {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.find((item) => item.id === id);
}

describe("context window indicator settings search entry", () => {
  it("titles the context window indicator entry without the legacy label and routes it to Appearance", () => {
    const entry = findCatalogItem(CONTEXT_WINDOW_INDICATOR_ID);
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Context window indicator");
    expect(entry!.title).not.toContain("(legacy)");
    expect(entry!.to).toBe("/settings/appearance");
  });

  it("drops the legacy context window indicator id from the settings search catalog", () => {
    expect(findCatalogItem("legacy-context-window-indicator")).toBeUndefined();
  });

  it.each(["context", "tokens", "cache", "ring"])(
    "finds the context window indicator entry when searching settings for %s",
    (query) => {
      expect(searchSettings(query).map((item) => item.id)).toContain(CONTEXT_WINDOW_INDICATOR_ID);
    },
  );
});
