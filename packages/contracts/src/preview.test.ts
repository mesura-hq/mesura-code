import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewEvent,
  PreviewSessionSnapshot,
  PreviewOpenInput,
  PreviewOpenLinkTargetInput,
  PreviewOpenLinkTargetResult,
} from "./preview.ts";
import {
  PreviewAutomationHost,
  PreviewAutomationOpenInput,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";

const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
const decodeLinkTargetInput = Schema.decodeUnknownSync(PreviewOpenLinkTargetInput);
const encodeLinkTargetInput = Schema.encodeUnknownSync(PreviewOpenLinkTargetInput);
const decodeLinkTargetResult = Schema.decodeUnknownSync(PreviewOpenLinkTargetResult);
const decodeManualOpenInput = Schema.decodeUnknownSync(PreviewOpenInput);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("thread-link allocation contracts", () => {
  const legacy = {
    threadId: "thread-link-contract",
    tabId: "tab-link-contract",
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as const;

  it("thread-link contracts decode legacy snapshots and retain the typed designation in events and lists", () => {
    expect(decodeSnapshot(legacy)).toEqual(legacy);
    const snapshot = { ...legacy, purpose: "thread-link", runtime: "server" } as const;
    expect(decodeSnapshot(snapshot)).toEqual(snapshot);
    const result = {
      selectedTabId: legacy.tabId,
      sessions: [snapshot, { ...legacy, tabId: "manual" }],
      serverEpoch: "epoch",
      revision: 1,
    };
    expect(decodeLinkTargetResult(result)).toEqual(result);
    expect(
      decodePreviewEvent({
        type: "opened",
        threadId: legacy.threadId,
        tabId: legacy.tabId,
        createdAt: legacy.updatedAt,
        serverEpoch: "epoch",
        revision: 1,
        snapshot,
      }),
    ).toMatchObject({ snapshot });
    expect(() => decodeSnapshot({ ...legacy, purpose: "manual" })).toThrow();
  });

  it("thread-link contracts accept only allocation settings and leave ordinary open untagged", () => {
    const input = { threadId: legacy.threadId, profileId: "work", viewport: { _tag: "fill" } };
    expect(decodeLinkTargetInput(input)).toEqual(input);
    expect(encodeLinkTargetInput(decodeLinkTargetInput(input))).toEqual(input);
    expect(decodeLinkTargetInput({ threadId: legacy.threadId })).toEqual({
      threadId: legacy.threadId,
    });
    expect(() => decodeLinkTargetInput({ threadId: "" })).toThrow();
    expect(() =>
      decodeLinkTargetInput({ ...input, viewport: { _tag: "freeform", width: 1, height: 1 } }),
    ).toThrow();
    for (const field of [
      { url: "https://example.com/" },
      { runtime: "desktop" },
      { purpose: "thread-link" },
      { automationOwner: "provider-session" },
    ]) {
      expect(() => decodeLinkTargetInput({ ...input, ...field })).toThrow();
    }
    expect(
      decodeManualOpenInput({ threadId: legacy.threadId, purpose: "thread-link" }),
    ).not.toHaveProperty("purpose");
  });

  it("thread-link contracts require the complete authoritative allocation envelope", () => {
    const result = {
      selectedTabId: legacy.tabId,
      sessions: [legacy],
      serverEpoch: "epoch",
      revision: 1,
    };
    for (const field of ["selectedTabId", "sessions", "serverEpoch", "revision"] as const) {
      const incomplete = Object.fromEntries(
        Object.entries(result).filter(([key]) => key !== field),
      );
      expect(() => decodeLinkTargetResult(incomplete)).toThrow();
    }
    expect(() => decodeLinkTargetResult({ ...result, revision: -1 })).toThrow();
  });
});

describe("PreviewAutomationOpenInput", () => {
  it("retains the legacy show visibility alias", () => {
    expect(decodeOpenInput({ show: false })).toEqual({ show: false });
  });
});

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});
