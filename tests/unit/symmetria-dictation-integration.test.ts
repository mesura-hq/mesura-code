// @effect-diagnostics nodeBuiltinImport:off - verifies repository integration boundaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const source = (relativePath: string): string =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");
const exists = (relativePath: string): boolean =>
  NodeFS.existsSync(NodePath.join(repositoryRoot, relativePath));

describe("Symmetria dictation integration guards", () => {
  it("removes every destination-less renderer delivery entry point", () => {
    for (const removedPath of [
      "apps/web/src/symmetria/useSttDelivery.ts",
      "apps/web/src/symmetria/sttDelivery.ts",
      "apps/desktop/src/symmetria/sttBridge.ts",
      "apps/desktop/src/symmetria/SttDelivery.ts",
    ]) {
      expect(exists(removedPath), removedPath).toBe(false);
    }

    const combinedRendererSurface = [
      source("apps/web/src/components/ChatView.tsx"),
      source("apps/desktop/src/preload.ts"),
      source("apps/desktop/src/ipc/channels.ts"),
      source("packages/contracts/src/ipc.ts"),
    ].join("\n");
    expect(combinedRendererSurface).not.toMatch(
      /useSttDelivery|onSttDelivery|resolveSttDelivery|STT_DELIVER_CHANNEL/,
    );
  });

  it("keeps the old socket as a refusal-only compatibility endpoint", () => {
    const endpoint = source("apps/desktop/src/symmetria/LegacySttEndpoint.ts");

    expect(endpoint).toContain('code: "reserved-session-required"');
    expect(endpoint).toContain("Mesura requires a reserved dictation session");
    expect(endpoint).not.toMatch(/ElectronWindow|DesktopIpc|webContents|DICTATION_RENDERER/);
  });

  it("restores broker snapshots and documents the exact-target recovery contract", () => {
    const bridge = source("apps/web/src/symmetria/useDictationBridge.ts");
    const coordinator = source("apps/web/src/symmetria/dictationCoordinator.ts");
    const internals = source("docs/internals/symmetria-dictation.md");
    const normalizedInternals = internals.replaceAll(/\s+/g, " ");

    expect(bridge).toContain("dictationCoordinator.restoreSession(decoded.success)");
    expect(bridge).not.toContain("getConfirmationRecovery()");
    expect(bridge).not.toContain("resumeConfirmation(");
    expect(coordinator).toContain("const restoreSession =");
    expect(normalizedInternals).toContain("Delivery resolves only the reservation");
    expect(normalizedInternals).toContain("never selects a replacement target");
    expect(normalizedInternals).toContain("accepted the normal thread submission command");
  });
});
