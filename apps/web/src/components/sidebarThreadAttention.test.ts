import { agentQuestionIsOpen } from "@t3tools/client-runtime/state/thread-inbox";
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

const FACTORY_ASKED_AT = "2026-11-23T13:34:00.821Z";

const factoryRunAt = (
  status: FactoryRunShellSummary["status"],
  node: string | null = "review",
): FactoryRunShellSummary => ({
  status,
  phaseIndex: 5,
  phaseCount: 11,
  node,
  askedAt: status === "waiting" || status === "stopped" ? FACTORY_ASKED_AT : null,
});

function attention(
  input: Partial<{
    status: SidebarThreadStatus;
    isUnread: boolean;
    isWoke: boolean;
    agentSignal: ThreadAgentSignal | null;
    agentExecuting: boolean;
    factoryRun: FactoryRunShellSummary | null;
    latestUserAuthoredMessageAt: string | null;
  }> = {},
) {
  const { agentSignal = null, latestUserAuthoredMessageAt = null, ...rest } = input;
  return resolveSidebarThreadAttention({
    status: "ready",
    isUnread: false,
    isWoke: false,
    agentExecuting: false,
    factoryRun: null,
    ...rest,
    agentQuestionOpen: agentQuestionIsOpen({
      agentSignal,
      factoryRun: rest.factoryRun ?? null,
      latestUserAuthoredMessageAt,
    }),
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

  it("an open agent question keeps the busy label, with the question marked, while the agent executes", () => {
    expect(attention({ status: "working", agentSignal: needsInput, agentExecuting: true })).toEqual(
      { kind: "working", text: "Working", emphasis: "quiet", questionOpen: true },
    );
    expect(attention({ status: "waiting", agentSignal: needsInput, agentExecuting: true })).toEqual(
      { kind: "waiting", text: "Waiting", emphasis: "quiet", questionOpen: true },
    );
    expect(
      attention({
        status: "working",
        agentSignal: needsInput,
        agentExecuting: true,
        factoryRun: factoryRunAt("running"),
      }),
    ).toMatchObject({ kind: "factory", questionOpen: true });
    expect(attention({ status: "working", agentExecuting: true })).not.toHaveProperty(
      "questionOpen",
    );
  });

  it("structured input and approvals still win over an executing agent's open question", () => {
    expect(
      attention({ status: "input", agentSignal: needsInput, agentExecuting: true })?.kind,
    ).toBe("input");
    expect(
      attention({ status: "approval", agentSignal: needsInput, agentExecuting: true })?.kind,
    ).toBe("approval");
  });

  it("sidebar attention AC3: a ready_to_close signal uses the normal finished presentation", () => {
    const expected = { kind: "done", text: "Done", emphasis: "calm" };
    expect(attention({ agentSignal: readyToClose, isUnread: true })).toEqual(expected);
    expect(attention({ agentSignal: readyToClose, isUnread: false })).toBeNull();
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

  it.each(["waiting", "stopped"] as const)(
    "sidebar attention AC5: a Factory run in status %s reads a loud Needs input until the user writes after it",
    (status) => {
      expect(attention({ factoryRun: factoryRunAt(status) })).toEqual({
        kind: "input",
        text: "Needs input",
        emphasis: "loud",
      });
      expect(attention({ status: "working", factoryRun: factoryRunAt(status) })?.kind).toBe(
        "input",
      );
      expect(
        attention({
          factoryRun: factoryRunAt(status),
          latestUserAuthoredMessageAt: "2026-11-23T13:40:00.000Z",
          isUnread: true,
        })?.kind,
      ).toBe("done");
    },
  );

  // 2026-11-24: a run stopped on 11-23 kept "Needs input" on a thread whose agent worked for a
  // day after the developer had answered in it.
  it("sidebar attention AC5: an answered stopped Factory run lets the executing agent read Working", () => {
    expect(
      attention({
        status: "working",
        agentExecuting: true,
        factoryRun: factoryRunAt("stopped"),
        latestUserAuthoredMessageAt: "2026-11-24T18:12:15.377Z",
      }),
    ).toEqual({ kind: "working", text: "Working", emphasis: "quiet" });
  });

  it("sidebar attention AC5: an unanswered Factory question marks the busy label while the agent executes", () => {
    expect(
      attention({ status: "working", agentExecuting: true, factoryRun: factoryRunAt("waiting") }),
    ).toEqual({ kind: "working", text: "Working", emphasis: "quiet", questionOpen: true });
  });

  // Seal disposition check P1-2: Preparing has no busy label to carry the question's marker.
  it("an open question reads Needs input while the thread prepares", () => {
    for (const factoryRun of [factoryRunAt("stopped"), factoryRunAt("waiting")]) {
      expect(attention({ status: "preparing", agentExecuting: true, factoryRun })?.kind).toBe(
        "input",
      );
    }
    expect(
      attention({ status: "preparing", agentExecuting: true, agentSignal: needsInput })?.kind,
    ).toBe("input");
    expect(attention({ status: "preparing", agentExecuting: true })).toBeNull();
  });

  // Seal confirm P1-5: the Preparing rule must not hide a guest's Request behind the question.
  it("a guest request outranks an executing agent's open question, as before", () => {
    expect(
      attention({ status: "request", agentExecuting: true, agentSignal: needsInput })?.kind,
    ).toBe("request");
    expect(
      attention({ status: "request", agentExecuting: true, factoryRun: factoryRunAt("stopped") })
        ?.kind,
    ).toBe("request");
    expect(
      attention({
        status: "preparing",
        agentExecuting: true,
        agentSignal: needsInput,
        factoryRun: factoryRunAt("running"),
      }),
    ).toMatchObject({ kind: "factory", questionOpen: true });
  });

  it("sidebar attention AC5: a Factory run from a server without askedAt stays Needs input", () => {
    const { askedAt: _askedAt, ...undated } = factoryRunAt("stopped");
    expect(
      attention({ factoryRun: undated, latestUserAuthoredMessageAt: "2026-11-24T18:12:15.377Z" })
        ?.kind,
    ).toBe("input");
  });

  // The developer, 2026-10-24: a run that finished degraded is finished; the degraded phases
  // belong in its report, not in a row label that never goes away.
  it("sidebar attention: a Factory run that finished degraded reads like a done run, not Needs input", () => {
    expect(attention({ factoryRun: factoryRunAt("degraded", null), isUnread: false })).toBeNull();
    expect(
      attention({
        factoryRun: factoryRunAt("degraded", null),
        isUnread: true,
      })?.kind,
    ).toBe("done");
  });

  it("sidebar attention AC5: a done Factory run uses the normal finished presentation", () => {
    expect(attention({ factoryRun: factoryRunAt("done", null), isUnread: false })).toBeNull();
    expect(
      attention({
        factoryRun: factoryRunAt("done", null),
        isUnread: true,
      })?.kind,
    ).toBe("done");
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

  it("sidebar attention AC8: a needs_input row never recedes; a read finished row does", () => {
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

  it("sidebar attention guard: Woke outranks Done and yields to busy work", () => {
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
