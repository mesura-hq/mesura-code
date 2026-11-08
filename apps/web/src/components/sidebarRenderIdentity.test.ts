import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import {
  sameSortableRowProps,
  sidebarListItemsFromIdentityKey,
  sidebarListItemsIdentityKey,
} from "./sidebarRenderIdentity";
import type { SidebarListItem } from "./Sidebar.logic";

function Row(_props: Record<string, unknown>) {
  return null;
}
const thread = { id: "t1" };
const onSettle = () => {};
const wrapper = (rowProps: Record<string, unknown>, own: Record<string, unknown> = {}) => ({
  id: "env:t1",
  disabled: false,
  ...own,
  row: createElement(Row, { key: "env:t1:card", ...rowProps }),
});

describe("sameSortableRowProps", () => {
  it("skips a row whose element carries the same props", () => {
    expect(sameSortableRowProps(wrapper({ thread, onSettle }), wrapper({ thread, onSettle }))).toBe(
      true,
    );
  });

  it("renders a row whose thread changed", () => {
    expect(
      sameSortableRowProps(
        wrapper({ thread, onSettle }),
        wrapper({ thread: { id: "t1" }, onSettle }),
      ),
    ).toBe(false);
  });

  it("renders a row whose own props changed", () => {
    expect(
      sameSortableRowProps(
        wrapper({ thread }, { disabled: false }),
        wrapper({ thread }, { disabled: true }),
      ),
    ).toBe(false);
  });

  it("does not equate a missing prop with one set to undefined under another name", () => {
    expect(sameSortableRowProps(wrapper({ a: undefined }), wrapper({ b: undefined }))).toBe(false);
  });

  it("renders a row whose variant key changed", () => {
    const previous = wrapper({ thread });
    const next = { ...previous, row: createElement(Row, { key: "env:t1:slim", thread }) };
    expect(sameSortableRowProps(previous, next)).toBe(false);
  });
});

describe("sidebarListItemsIdentityKey", () => {
  it("round-trips the list's structure", () => {
    const items: SidebarListItem[] = [
      { kind: "marker", marker: "pinned-header" },
      { kind: "thread", key: "env:a", section: "pinned" },
      { kind: "marker", marker: "pinned-divider" },
      { kind: "thread", key: "env:b", section: "active" },
    ];
    expect(sidebarListItemsFromIdentityKey(sidebarListItemsIdentityKey(items))).toEqual(items);
    expect(sidebarListItemsFromIdentityKey(sidebarListItemsIdentityKey([]))).toEqual([]);
  });

  it("changes when a row moves section", () => {
    const before: SidebarListItem[] = [{ kind: "thread", key: "env:a", section: "active" }];
    const after: SidebarListItem[] = [{ kind: "thread", key: "env:a", section: "pinned" }];
    expect(sidebarListItemsIdentityKey(before)).not.toBe(sidebarListItemsIdentityKey(after));
  });
});
