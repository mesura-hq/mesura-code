/**
 * One owner of the store path.
 *
 * Acceptance criterion 5. This is the piece the research called out as needed
 * by both consumers and implemented by neither: a single function that decides
 * where the frecency and history databases live.
 *
 * It matters beyond tidiness. The engine refuses to open the same store twice
 * inside one process, so two callers that disagree about the path produce two
 * environments and a failure that reads as "environment already open"; and the
 * tests rely on the override to stay out of the operator's real store.
 */
import { describe, expect, it } from "vitest";

import { resolveStorePaths } from "../src/main/store.ts";

describe("resolveStorePaths", () => {
  it("puts both databases under the XDG data directory by default", () => {
    const paths = resolveStorePaths({ HOME: "/home/someone" });
    expect(paths.frecencyDbPath).toBe("/home/someone/.local/share/symmetria/fff/frecency");
    expect(paths.historyDbPath).toBe("/home/someone/.local/share/symmetria/fff/history");
  });

  it("honours XDG_DATA_HOME when it is set", () => {
    const paths = resolveStorePaths({ HOME: "/home/someone", XDG_DATA_HOME: "/data" });
    expect(paths.frecencyDbPath).toBe("/data/symmetria/fff/frecency");
    expect(paths.historyDbPath).toBe("/data/symmetria/fff/history");
  });

  it("lets SYMMETRIA_FM_FRECENCY_DIR override the location entirely", () => {
    // The tests isolate the store into a temp directory through this variable,
    // and it doubles as the user's relocation hook. It outranks XDG_DATA_HOME.
    const paths = resolveStorePaths({
      HOME: "/home/someone",
      XDG_DATA_HOME: "/data",
      SYMMETRIA_FM_FRECENCY_DIR: "/tmp/isolated",
    });
    expect(paths.frecencyDbPath).toBe("/tmp/isolated/frecency");
    expect(paths.historyDbPath).toBe("/tmp/isolated/history");
  });

  it("returns the two databases in separate directories", () => {
    const paths = resolveStorePaths({ SYMMETRIA_FM_FRECENCY_DIR: "/tmp/isolated" });
    expect(paths.frecencyDbPath).not.toBe(paths.historyDbPath);
  });

  it("reads the real environment when it is given none", () => {
    // The production call site passes nothing. It must still resolve, rather
    // than silently returning empty strings the engine would then create a
    // store at the process working directory for.
    const paths = resolveStorePaths();
    expect(paths.frecencyDbPath).not.toBe("");
    expect(paths.frecencyDbPath).toContain("symmetria");
  });
});
