import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composeAgentSearchDescription,
  describeAgentSearchCoverage,
  describeAgentSearchVerdict,
  resolveAgentSearchModelEnvironmentId,
} from "./agentThreadSearchPresentation.ts";

const FULL_COVERAGE = {
  unavailableEnvironments: [],
  budgetExhausted: false,
  unreadEvidence: false,
};

describe("composeAgentSearchDescription", () => {
  it("agent description keeps every turn in order when they fit", () => {
    expect(composeAgentSearchDescription(["file tree lag", "on the laptop"], 100)).toBe(
      "file tree lag\non the laptop",
    );
  });

  it("agent description drops the oldest turns so the newest refinement survives the limit", () => {
    expect(
      composeAgentSearchDescription(["a very old first description", "second", "newest"], 20),
    ).toBe("second\nnewest");
  });

  it("agent description clamps a single overlong turn from its end", () => {
    expect(composeAgentSearchDescription(["abcdefghij"], 4)).toBe("abcd");
  });

  it("agent description composes on Hermes, which has no Array#toReversed", () => {
    // Mobile runs this helper on Hermes. An own `toReversed` of undefined hides
    // the Node prototype method, so a helper that calls it throws here too.
    const turns = Object.freeze(
      Object.assign(["the tablet sidebar", "about host statistics", "last week"], {
        toReversed: undefined,
      }),
    );
    expect(composeAgentSearchDescription(turns, 34)).toBe("about host statistics\nlast week");
    expect([...turns]).toEqual(["the tablet sidebar", "about host statistics", "last week"]);
  });
});

describe("describeAgentSearchCoverage", () => {
  it("agent coverage is silent when the search saw everything", () => {
    expect(describeAgentSearchCoverage(FULL_COVERAGE)).toEqual([]);
  });

  it("agent coverage names unreachable environments, an exhausted budget, and unread evidence together", () => {
    expect(
      describeAgentSearchCoverage({
        unavailableEnvironments: [{ label: "Vigilia" }, { label: "Laptop" }],
        budgetExhausted: true,
        unreadEvidence: true,
      }),
    ).toEqual([
      "Could not reach Vigilia, Laptop, so their threads were not searched.",
      "The search stopped at its work limit, so older matches may be missing.",
      "Some matching messages were found but not reviewed.",
    ]);
  });

  it("agent coverage reports unread evidence when the budget held", () => {
    expect(describeAgentSearchCoverage({ ...FULL_COVERAGE, unreadEvidence: true })).toEqual([
      "Some matching messages were found but not reviewed.",
    ]);
  });
});

describe("resolveAgentSearchModelEnvironmentId", () => {
  const laptop = { environmentId: EnvironmentId.make("laptop"), label: "Laptop" };
  const vigilia = { environmentId: EnvironmentId.make("vigilia"), label: "Vigilia" };

  it("agent model environment keeps the preferred environment while it is searched", () => {
    expect(resolveAgentSearchModelEnvironmentId([laptop, vigilia], vigilia.environmentId)).toBe(
      vigilia.environmentId,
    );
  });

  it("agent model environment falls back to the first searched environment", () => {
    expect(
      resolveAgentSearchModelEnvironmentId([laptop, vigilia], EnvironmentId.make("gone")),
    ).toBe(laptop.environmentId);
    expect(resolveAgentSearchModelEnvironmentId([vigilia], null)).toBe(vigilia.environmentId);
  });

  it("agent model environment is null when nothing is connected", () => {
    expect(resolveAgentSearchModelEnvironmentId([], null)).toBeNull();
  });
});

describe("describeAgentSearchVerdict", () => {
  it("agent verdict is silent for matches and names a model failure apart from a retrieval failure", () => {
    expect(
      describeAgentSearchVerdict({ status: "matches", matches: [], coverage: FULL_COVERAGE }),
    ).toBeNull();
    const model = describeAgentSearchVerdict({
      status: "failed",
      failure: "model",
      coverage: FULL_COVERAGE,
    });
    const retrieval = describeAgentSearchVerdict({
      status: "failed",
      failure: "retrieval",
      coverage: FULL_COVERAGE,
    });
    expect(model).toMatchObject({ tone: "alert", text: expect.stringMatching(/model/) });
    expect(retrieval).toMatchObject({ tone: "alert" });
    expect(retrieval?.text).not.toMatch(/model/);
  });

  it("agent verdict reports no confident match as a status", () => {
    expect(
      describeAgentSearchVerdict({ status: "noConfidentMatch", coverage: FULL_COVERAGE }),
    ).toMatchObject({ tone: "status", text: expect.stringMatching(/^No confident match/) });
  });
});
