// Entry point: `factoryRunShortLabel` (runPresentation.ts), the text the sidebar's top status
// slot shows for a running Software Factory run. The long `factoryRunLabel` stays for the run
// card and the accessible label; runPresentation.test.ts pins it.
import { describe, expect, it } from "vite-plus/test";

import { factoryRunLabel, factoryRunShortLabel } from "./runPresentation.ts";

describe("factory run short label", () => {
  it("factory short label: a running run reads phase/count and the node, without the word phase", () => {
    expect(
      factoryRunShortLabel({ status: "running", phaseIndex: 5, phaseCount: 11, node: "review" }),
    ).toBe("5/11 Review");
    expect(
      factoryRunShortLabel({ status: "running", phaseIndex: 2, phaseCount: 6, node: "verify-1" }),
    ).toBe("2/6 Verify ①");
    expect(
      factoryRunShortLabel({ status: "running", phaseIndex: 5, phaseCount: 11, node: null }),
    ).toBe("5/11");
  });

  it("factory short label: a run before its first phase reads Starting; no run reads nothing", () => {
    expect(
      factoryRunShortLabel({ status: "running", phaseIndex: 0, phaseCount: 0, node: null }),
    ).toBe("Starting");
    expect(factoryRunShortLabel(null)).toBeNull();
    expect(factoryRunShortLabel(undefined)).toBeNull();
  });

  it("factory short label guard: the long label keeps its phase wording", () => {
    expect(
      factoryRunLabel({ status: "running", phaseIndex: 5, phaseCount: 11, node: "review" })?.text,
    ).toBe("phase 5/11 · Review");
  });
});
