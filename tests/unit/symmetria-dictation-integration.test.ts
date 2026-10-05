// @effect-diagnostics nodeBuiltinImport:off - verifies repository integration boundaries.
/**
 * Fence for the removal of Symmetria Shell's dictation link.
 *
 * Dictation is Mesura's own now (server transcription, marker tokens,
 * send-when-ready). Shell's dictation sockets, the renderer bridge and the
 * prototype page were removed, and this guard fails if any of them returns to
 * the desktop or web sources. The thread feed's socket stays and is pinned
 * here so that the fence can never catch it by accident.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const absolute = (relativePath: string): string => NodePath.join(repositoryRoot, relativePath);
const source = (relativePath: string): string =>
  NodeFS.readFileSync(absolute(relativePath), "utf8");

const SCANNED_SOURCE_ROOTS = ["apps/desktop/src", "apps/web/src"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const listSourceFiles = (relativeRoot: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(absolute(relativeRoot), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(NodePath.extname(entry.name)))
    .map((entry) => NodePath.relative(repositoryRoot, NodePath.join(entry.parentPath, entry.name)));

/**
 * Each removed name, and the pattern that finds it. The legacy STT socket was
 * `symmetria-mesura-<pid>.sock`: its pattern takes any interpolation, placeholder
 * or number in the pid slot directly after the prefix, and requires `.sock`, so
 * the thread socket (`symmetria-mesura-threads-<pid>.sock`) and the per-user
 * runtime fallback directory (`symmetria-mesura-<uid>`, no `.sock`) do not match.
 */
const REMOVED_NAMES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "dictation socket symmetria-mesura-dictation-", pattern: /symmetria-mesura-dictation-/ },
  {
    name: "legacy STT socket symmetria-mesura-<pid>.sock",
    pattern: /symmetria-mesura-(?!threads-)(?:\$\{[^}]+\}|<[^>]+>|\d+)\.sock/,
  },
  { name: "bridge symmetriaDictationBridge", pattern: /symmetriaDictationBridge/ },
  { name: "layer DictationBroker", pattern: /\bDictationBroker\b/ },
  { name: "layer LegacySttEndpoint", pattern: /\bLegacySttEndpoint\b/ },
  { name: "layer SttSocket", pattern: /\bSttSocket\b/ },
  { name: "route /prototype/dictation", pattern: /\/prototype\/dictation/ },
];

const findRemovedNameHits = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.flatMap((file) => {
    const text = source(file);
    return REMOVED_NAMES.filter(({ pattern }) => pattern.test(text)).map(
      ({ name }) => `${file}: ${name}`,
    );
  });

describe("Symmetria Shell dictation link removal fence", () => {
  it("finds none of the removed Shell dictation names in desktop or web sources", () => {
    const files = SCANNED_SOURCE_ROOTS.flatMap(listSourceFiles);
    expect(files.length).toBeGreaterThan(0);
    expect(findRemovedNameHits(files)).toEqual([]);
  });

  it("keeps the removed Shell dictation files and the prototype route deleted", () => {
    const stillPresent = [
      "apps/desktop/src/symmetria/DictationBroker.ts",
      "apps/desktop/src/symmetria/LegacySttEndpoint.ts",
      "apps/desktop/src/symmetria/SttSocket.ts",
      "apps/desktop/src/symmetria/dictationSocketFiles.ts",
      "apps/desktop/src/symmetria/sttSocketFiles.ts",
      "apps/web/src/symmetria/useDictationBridge.ts",
      "apps/web/src/symmetria/dictationCoordinator.ts",
      "apps/web/src/routes/prototype.dictation.tsx",
      "apps/web/src/prototypes",
    ].filter((relativePath) => NodeFS.existsSync(absolute(relativePath)));
    expect(stillPresent).toEqual([]);
  });

  it("does not mistake the kept thread socket or runtime directory for a removed name", () => {
    const threadSocketFiles = source("apps/desktop/src/symmetria/threadSocketFiles.ts");
    const socketFiles = source("apps/desktop/src/symmetria/socketFiles.ts");
    expect(threadSocketFiles).toContain("`symmetria-mesura-threads-${pid}.sock`");
    expect(socketFiles).toContain('`${NodeOS.tmpdir()}/symmetria-mesura-${uid ?? "nouid"}`');

    const keptNames = [
      "symmetria-mesura-threads-4242.sock",
      "`symmetria-mesura-threads-${pid}.sock`",
      "/tmp/symmetria-mesura-1000",
      '`${NodeOS.tmpdir()}/symmetria-mesura-${uid ?? "nouid"}`',
    ];
    for (const keptName of keptNames) {
      for (const { name, pattern } of REMOVED_NAMES) {
        expect(pattern.test(keptName), `${name} must not match ${keptName}`).toBe(false);
      }
    }
  });

  it("recognises the legacy STT socket name however its pid is written", () => {
    const legacySocket = REMOVED_NAMES.find(({ name }) => name.startsWith("legacy STT socket"));
    expect(legacySocket).toBeDefined();
    for (const returnedName of [
      "`symmetria-mesura-${pid}.sock`",
      "`symmetria-mesura-${process.pid}.sock`",
      "`symmetria-mesura-${shellPid}.sock`",
      "/run/user/1000/symmetria-mesura-4242.sock",
    ]) {
      expect(legacySocket!.pattern.test(returnedName), returnedName).toBe(true);
    }
  });

  it("still composes the thread publisher into the desktop application", () => {
    const desktopMain = source("apps/desktop/src/main.ts");
    expect(desktopMain).toContain(
      'import * as ThreadPublisher from "./symmetria/ThreadPublisher.ts";',
    );
    expect(desktopMain).toMatch(/^\s*ThreadPublisher\.layer,$/m);
  });
});
