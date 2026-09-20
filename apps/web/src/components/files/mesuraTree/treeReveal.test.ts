import { describe, expect, it } from "vite-plus/test";

import { nextRevealRequest } from "./treeReveal";

describe("nextRevealRequest", () => {
  it("reveals a newly selected path once", () => {
    const first = nextRevealRequest(null, "src/main.ts", 0);
    expect(first.reveal).toBe(true);
    const again = nextRevealRequest(first.handled, "src/main.ts", 0);
    expect(again.reveal).toBe(false);
    expect(again.handled).toEqual(first.handled);
  });

  it("reveals the same path again only when the reveal id changes", () => {
    const first = nextRevealRequest(null, "src/main.ts", 3);
    const bumped = nextRevealRequest(first.handled, "src/main.ts", 4);
    expect(bumped.reveal).toBe(true);
    expect(bumped.handled).toEqual({ path: "src/main.ts", revealId: 4 });
  });

  it("reveals a different path with the same id", () => {
    const first = nextRevealRequest(null, "src/main.ts", 1);
    const other = nextRevealRequest(first.handled, "README.md", 1);
    expect(other.reveal).toBe(true);
  });

  it("forgets the handled request when no file is selected", () => {
    const first = nextRevealRequest(null, "src/main.ts", 1);
    const cleared = nextRevealRequest(first.handled, null, 1);
    expect(cleared.reveal).toBe(false);
    expect(cleared.handled).toBeNull();
  });
});
