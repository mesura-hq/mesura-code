import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The panel must not know what origin it is served from.
 *
 * Acceptance criteria 2 and 3 of phase 3.
 *
 * **This property also holds by accident.** The renderer never names the
 * application's private URL scheme because `previewUrlFor` builds preview URLs
 * in the main process and they cross the bridge as opaque strings — and that
 * arrangement exists because Chromium's PDF viewer refuses a `blob:` URL from a
 * custom scheme, which is a completely unrelated problem.
 *
 * Inside Mesura Code the panel is served from that application's own origin. A
 * scheme literal here would work in the standalone and silently 404 in the
 * embedding, which is the worst shape a coupling can take: invisible until the
 * thing it breaks is somebody else's build.
 *
 * It must also stay off Node. The renderer runs sandboxed with no filesystem,
 * so a `node:` import would compile in a host that happens to allow it and
 * crash in the one that does not.
 */
const root = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the panel is origin-blind", () => {
  it("has sources to check, so this suite cannot pass by finding nothing", () => {
    expect(sources(root).length).toBeGreaterThan(10);
  });

  it("never names the application's private URL scheme", () => {
    const offenders = sources(root).filter((file) =>
      readFileSync(file, "utf8").includes("symmetria-fm://"),
    );

    expect(offenders, `these name a scheme the host owns:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("imports nothing from Node", () => {
    // The renderer is sandboxed by construction. This is the compile-time half
    // of a guarantee the runtime already enforces, so the failure arrives at a
    // build rather than in front of the user.
    const offenders = sources(root).filter((file) =>
      /from\s+["']node:/.test(readFileSync(file, "utf8")),
    );

    expect(offenders, `these import from node:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("imports nothing from Electron", () => {
    // Not even a type. The panel talks to its host through one injected bridge
    // object; naming Electron would tie it to one kind of host.
    const offenders = sources(root).filter((file) =>
      /from\s+["']electron["']/.test(readFileSync(file, "utf8")),
    );

    expect(offenders, `these import electron:\n${offenders.join("\n")}`).toEqual([]);
  });
});
