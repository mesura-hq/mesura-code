import { Suspense, use, useRef, useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarThreadHeader } from "./SidebarThreadHeader";

function Results({
  query,
  ready,
  initialQuery,
}: {
  query: string;
  ready: Promise<void>;
  initialQuery: string;
}) {
  if (query !== initialQuery) use(ready);
  return <output aria-label="Results query">{query}</output>;
}

function SearchHarness({
  ready,
  initialQuery = "",
}: {
  ready: Promise<void>;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <SidebarProvider>
      <SidebarThreadHeader
        hasProjects={false}
        projectScope={null}
        onNewProject={() => {}}
        onNewThread={() => {}}
        newThreadDisabled
        newThreadShortcutLabel={null}
        newThreadInProjectShortcutLabel={null}
        showNewThreadInProjectHint={false}
        searchInputRef={inputRef}
        searchQuery={query}
        onSearchQueryChange={setQuery}
        onSearchKeyDown={(event, clearSearch) => {
          if (event.key === "Escape" && event.currentTarget.value.trim()) {
            event.preventDefault();
            event.stopPropagation();
            clearSearch();
          }
        }}
        isSearching={query !== ""}
        searchResultCount={query ? 1 : 0}
        activeSearchResultIndex={0}
        onClearSearch={() => setQuery("")}
        renderSearchFieldAccessory={(value) => <output aria-label="Agent query">{value}</output>}
      />
      <Suspense>
        <Results query={query} ready={ready} initialQuery={initialQuery} />
      </Suspense>
    </SidebarProvider>
  );
}

it.each(["button", "Escape"])(
  "keeps every keystroke and the caret while results wait, then clears with %s",
  async (method) => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await using screen = await render(<SearchHarness ready={ready} />);
    const field = screen.getByRole("combobox", { name: "Search threads" });
    await userEvent.type(field, "mesura");
    await expect.element(field).toHaveValue("mesura");
    await expect.element(field).toHaveAttribute("aria-busy", "true");
    await expect.element(field).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}X");
    await expect.element(field).toHaveValue("mesuXra");
    expect((field.element() as HTMLInputElement).selectionStart).toBe(5);
    await expect
      .element(screen.getByRole("status", { name: "Agent query" }))
      .toHaveTextContent("mesuXra");

    if (method === "button") {
      await userEvent.click(screen.getByRole("button", { name: "Clear thread search" }));
    } else {
      await userEvent.keyboard("{Escape}");
    }
    await expect.element(field).toHaveValue("");
    finish();
    await expect.element(field).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("status", { name: "Results query" }).element().textContent).toBe("");
    await expect.element(field).toHaveValue("");
  },
);

it("commits the latest query after pending results finish", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await using screen = await render(<SearchHarness ready={ready} />);
  const field = screen.getByRole("combobox", { name: "Search threads" });
  await userEvent.type(field, "mesura");
  await expect.element(field).toHaveValue("mesura");
  finish();
  await expect
    .element(screen.getByRole("status", { name: "Results query" }))
    .toHaveTextContent("mesura");
  await expect.element(field).toHaveAttribute("aria-busy", "false");
  expect((field.element() as HTMLInputElement).selectionStart).toBe(6);
});

it("keeps the existing list expanded while its replacement waits", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await using screen = await render(<SearchHarness ready={ready} initialQuery="me" />);
  const field = screen.getByRole("combobox", { name: "Search threads" });
  await userEvent.click(field);
  await userEvent.keyboard("{End}su");
  await expect.element(field).toHaveValue("mesu");
  await expect.element(field).toHaveAttribute("aria-busy", "true");
  await expect.element(field).toHaveAttribute("aria-expanded", "true");
  await expect.element(field).toHaveAttribute("aria-controls", "sidebar-thread-search-results");
  await expect.element(field).not.toHaveAttribute("aria-activedescendant");
  finish();
  await expect.element(field).toHaveAttribute("aria-busy", "false");
});
