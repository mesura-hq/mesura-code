import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("thread-link capability is optional for old environments and independent of server browser support", () => {
    expect(decodeDescriptor(descriptor).capabilities.threadLinkPreview).toBeUndefined();
    expect(
      decodeDescriptor({ ...descriptor, capabilities: { serverBrowser: true } }).capabilities
        .threadLinkPreview,
    ).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { serverBrowser: true, threadLinkPreview: true },
      }).capabilities.threadLinkPreview,
    ).toBe(true);
    expect(
      decodeDescriptor({ ...descriptor, capabilities: { threadLinkPreview: false } }).capabilities
        .threadLinkPreview,
    ).toBe(false);
  });
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
  it("requires an advertised required-worktree bootstrap capability", () => {
    expect(decodeDescriptor(descriptor).capabilities.requiredWorktreeBootstrap).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, requiredWorktreeBootstrap: true },
      }).capabilities.requiredWorktreeBootstrap,
    ).toBe(true);
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("issues phase 3 guard: treats a missing issue reference capability as unsupported under version skew", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, issues: true },
      }).capabilities.issueReferences,
    ).toBeUndefined();
  });

  it("issues phase 3 fence: preserves an advertised issue reference capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, issues: true, issueReferences: true },
      }).capabilities.issueReferences,
    ).toBe(true);
  });

  it("treats a missing Issues capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.issues).toBeUndefined();
  });

  it("preserves an advertised Issues capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, issues: true },
      }).capabilities.issues,
    ).toBe(true);
  });

  it("preserves an Issues capability a server explicitly disables", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, issues: false },
      }).capabilities.issues,
    ).toBe(false);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("treats missing server-resolved command context as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverResolvedCommandContext).toBeUndefined();
  });

  it("preserves advertised server-resolved command context", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          serverResolvedCommandContext: true,
        },
      }).capabilities.serverResolvedCommandContext,
    ).toBe(true);
  });
});
