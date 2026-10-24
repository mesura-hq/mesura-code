// Entry point: `resolveSidebarThreadAttention` (sidebarThreadAttention.ts), the one decision the
// current sidebar's top status slot and the in-tab notifications read. Its input is the status
// `resolveSidebarThreadStatus` returns plus the shell facts the status does not carry: the agent
// signal, the Software Factory run summary and whether an open pull request remains. The
// precedence follows the prototype's `statusAfter` (/home/dev/plans/thread-attention/prototype).
import { RunId, type FactoryRunShellSummary, type ThreadAgentSignal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadStatus } from "./Sidebar.logic";
import { shouldRecedeSidebarThread } from "./Sidebar.logic";
import { resolveSidebarThreadAttention } from "./sidebarThreadAttention";

const needsInput: ThreadAgentSignal = {
  kind: "needs_input",
  note: "Which database should the migration target?",
  runId: RunId.make("run-sidebar-thread-attention-signal"),
  setAt: "2026-10-24T10:00:00.000Z",
};

const readyToClose: ThreadAgentSignal = { ...needsInput, kind: "ready_to_close", note: null };

const factoryRunAt = (
  status: FactoryRunShellSummary["status"],
  node: string | null = "review",
): FactoryRunShellSummary => ({ status, phaseIndex: 5, phaseCount: 11, node });

function attention(
  input: Partial<{
    status: SidebarThreadStatus;
    isUnread: boolean;
    isWoke: boolean;
    agentSignal: ThreadAgentSignal | null;
    factoryRun: FactoryRunShellSummary | null;
    hasOpenPullRequest: boolean;
  }> = {},
) {
  return resolveSidebarThreadAttention({
    status: "ready",
    isUnread: false,
    isWoke: false,
    agentSignal: null,
    factoryRun: null,
    hasOpenPullRequest: false,
    ...input,
  });
}

describe("sidebar thread attention mapping", () => {
  it("sidebar attention AC1: Working and Waiting share the quiet emphasis", () => {
    expect(attention({ status: "working" })).toEqual({
      kind: "working",
      text: "Working",
      emphasis: "quiet",
    });
    expect(attention({ status: "waiting" })).toEqual({
      kind: "waiting",
      text: "Waiting",
      emphasis: "quiet",
    });
  });

  it("sidebar attention AC2: a needs_input signal reads a loud Needs input, like structured input", () => {
    const structured = attention({ status: "input" });
    expect(structured).toEqual({ kind: "input", text: "Needs input", emphasis: "loud" });
    expect(attention({ agentSignal: needsInput })).toEqual(structured);
    expect(attention({ agentSignal: needsInput, isUnread: true })).toEqual(structured);
  });

  it("sidebar attention AC2: a needs_input signal ranks with input, below approval and above busy work", () => {
    expect(attention({ status: "approval", agentSignal: needsInput })?.kind).toBe("approval");
    for (const status of ["working", "waiting", "failed", "limited"] as const) {
      expect(attention({ status, agentSignal: needsInput })?.kind, status).toBe("input");
    }
    expect(
      attention({ status: "working", agentSignal: needsInput, factoryRun: factoryRunAt("running") })
        ?.kind,
    ).toBe("input");
  });

  it("sidebar attention AC3: a ready_to_close signal with no live work reads a calm Ready to close, not Done", () => {
    const expected = { kind: "ready_to_close", text: "Ready to close", emphasis: "calm" };
    expect(attention({ agentSignal: readyToClose, isUnread: true })).toEqual(expected);
    expect(attention({ agentSignal: readyToClose, isUnread: false })).toEqual(expected);
  });

  it("sidebar attention AC3: live work outranks a ready_to_close signal", () => {
    expect(attention({ status: "working", agentSignal: readyToClose })?.kind).toBe("working");
    expect(attention({ status: "waiting", agentSignal: readyToClose })?.kind).toBe("waiting");
    expect(attention({ status: "failed", agentSignal: readyToClose })?.kind).toBe("failed");
  });

  it("sidebar attention AC4: a running Factory run shows its short label, quiet, in place of Working and Waiting", () => {
    const expected = { kind: "factory", text: "5/11 Review", emphasis: "quiet" };
    // Phase 1 parks a running run's thread at Waiting; a coordinator turn in flight is Working.
    expect(attention({ status: "waiting", factoryRun: factoryRunAt("running") })).toEqual(expected);
    expect(attention({ status: "working", factoryRun: factoryRunAt("running") })).toEqual(expected);
  });

  it("sidebar attention AC4: approval, input and failure outrank a running Factory run", () => {
    const running = factoryRunAt("running");
    expect(attention({ status: "approval", factoryRun: running })?.kind).toBe("approval");
    expect(attention({ status: "input", factoryRun: running })?.kind).toBe("input");
    expect(attention({ status: "failed", factoryRun: running })?.kind).toBe("failed");
  });

  it.each(["waiting", "degraded", "stopped"] as const)(
    "sidebar attention AC5: a Factory run in status %s reads a loud Needs input",
    (status) => {
      expect(attention({ factoryRun: factoryRunAt(status) })).toEqual({
        kind: "input",
        text: "Needs input",
        emphasis: "loud",
      });
      expect(attention({ status: "working", factoryRun: factoryRunAt(status) })?.kind).toBe(
        "input",
      );
    },
  );

  it("sidebar attention AC5: a done Factory run reads Ready to close with no open pull request, otherwise Done", () => {
    expect(attention({ factoryRun: factoryRunAt("done", null), isUnread: false })).toEqual({
      kind: "ready_to_close",
      text: "Ready to close",
      emphasis: "calm",
    });
    expect(
      attention({
        factoryRun: factoryRunAt("done", null),
        hasOpenPullRequest: true,
        isUnread: true,
      })?.kind,
    ).toBe("done");
    expect(
      attention({ factoryRun: factoryRunAt("done", null), hasOpenPullRequest: true }),
    ).toBeNull();
  });

  it("sidebar attention AC8: approval and failure stay loud; quiet kinds never take the loud emphasis", () => {
    expect(attention({ status: "approval" })).toEqual({
      kind: "approval",
      text: "Approval",
      emphasis: "loud",
    });
    expect(attention({ status: "failed" })).toEqual({
      kind: "failed",
      text: "Failed",
      emphasis: "loud",
    });
    expect(attention({ status: "working" })?.emphasis).toBe("quiet");
    expect(attention({ status: "waiting" })?.emphasis).toBe("quiet");
    expect(attention({ factoryRun: factoryRunAt("running") })?.emphasis).toBe("quiet");
  });

  it("sidebar attention AC8: a needs_input row never recedes; a read Ready to close row does", () => {
    const row = { isWoke: false, isActive: false, isSelected: false };
    for (const status of ["ready", "waiting", "working"] as const) {
      const kind = attention({ status, agentSignal: needsInput })?.kind ?? null;
      expect(
        shouldRecedeSidebarThread({ ...row, status, isUnread: false, attentionKind: kind }),
        status,
      ).toBe(false);
    }
    const ready = attention({ agentSignal: readyToClose })?.kind ?? null;
    expect(
      shouldRecedeSidebarThread({ ...row, status: "ready", isUnread: false, attentionKind: ready }),
    ).toBe(true);
    expect(
      shouldRecedeSidebarThread({ ...row, status: "ready", isUnread: true, attentionKind: ready }),
    ).toBe(false);
  });
});

describe("sidebar thread attention mapping guards", () => {
  it("sidebar attention guard: an unread finished thread with nothing else reads Done", () => {
    expect(attention({ isUnread: true })?.kind).toBe("done");
    expect(attention({ isUnread: true })?.text).toBe("Done");
    expect(attention({ isUnread: false })).toBeNull();
  });

  it("sidebar attention guard: Woke outranks Ready to close and Done and yields to busy work", () => {
    expect(attention({ isWoke: true, isUnread: true })?.kind).toBe("woke");
    expect(attention({ isWoke: true })?.text).toBe("Woke");
    expect(attention({ isWoke: true, agentSignal: readyToClose })?.kind).toBe("woke");
    expect(attention({ isWoke: true, status: "working" })?.kind).toBe("working");
    expect(attention({ isWoke: true, agentSignal: needsInput })?.kind).toBe("input");
  });

  it("sidebar attention guard: a usage limit reads Limited above busy work", () => {
    expect(attention({ status: "limited" })?.kind).toBe("limited");
    expect(attention({ status: "limited" })?.text).toBe("Limited");
    expect(attention({ status: "limited", factoryRun: factoryRunAt("running") })?.kind).toBe(
      "limited",
    );
  });
});
