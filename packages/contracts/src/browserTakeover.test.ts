// The WebSocket's JSON layer decodes every payload against its RPC's schema, so these
// schemas are what refuse an operator answer the takeover card does not offer.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BrowserTakeoverAnswerInput } from "./browserTakeover.ts";
import {
  BROWSER_TAKEOVER_REASON_MAX_LENGTH,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";
import { WsPreviewAnswerTakeoverRequestRpc } from "./rpc.ts";

const decodeAnswer = Schema.decodeUnknownExit(BrowserTakeoverAnswerInput);
const decodeTurnItem = Schema.decodeUnknownExit(OrchestrationV2TurnItemJson);

const answer = (value: unknown) => ({
  threadId: "thread-1",
  turnItemId: "turn-item:takeover",
  answer: value,
});

const takeoverCard = (reason: string) => ({
  id: "turn-item:takeover",
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "node-1",
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "waiting",
  title: null,
  startedAt: "2026-11-01T12:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-11-01T12:00:00.000Z",
  type: "browser_takeover_request",
  tabId: "tab-login",
  reason,
  takeoverStatus: "pending",
});

describe("browser takeover contracts", () => {
  it("takeover regression: the answer RPC decodes its payload with the takeover answer schema", () => {
    expect(WsPreviewAnswerTakeoverRequestRpc.payloadSchema).toBe(BrowserTakeoverAnswerInput);
  });

  it.each(["done", "declined"])("takeover regression: the operator may answer %s", (value) => {
    expect(decodeAnswer(answer(value))._tag).toBe("Success");
  });

  it.each(["cancelled", "pending", "DONE", ""])(
    "takeover regression: the operator may not answer %j",
    (value) => {
      expect(decodeAnswer(answer(value))._tag).toBe("Failure");
    },
  );

  it("takeover regression: a takeover card's reason holds at most the tool's reason limit", () => {
    expect(decodeTurnItem(takeoverCard("a".repeat(BROWSER_TAKEOVER_REASON_MAX_LENGTH)))._tag).toBe(
      "Success",
    );
    expect(
      decodeTurnItem(takeoverCard("a".repeat(BROWSER_TAKEOVER_REASON_MAX_LENGTH + 1)))._tag,
    ).toBe("Failure");
  });
});
