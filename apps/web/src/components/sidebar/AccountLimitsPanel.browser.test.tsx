import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import "~/index.css";
import type { AccountLimitsRow, AccountLimitsView } from "../../state/accountLimits";
import { AccountLimitsPanelContent } from "./AccountLimitsPanel";

const NOW = Date.parse("2026-11-04T01:00:00.000Z");

function view(resetCredits: AccountLimitsRow["resetCredits"]): AccountLimitsView {
  return {
    environments: [],
    rows: [
      {
        key: "openai:me@example.com",
        driver: ProviderDriverKind.make("codex"),
        namespace: "openai",
        providerLabel: "ChatGPT",
        plan: "pro",
        subtitle: null,
        environments: [{ environmentId: EnvironmentId.make("local"), label: "Laptop" }],
        windows: [],
        resetCredits,
        state: "current",
        readingAgeMs: 60_000,
      },
    ],
    isPending: false,
    isPartial: false,
    refresh: () => {},
  };
}

describe("AccountLimitsPanel reset credits", () => {
  it("lists every dated reset when the summary line is hovered or tapped", async () => {
    await using _screen = await render(
      <AccountLimitsPanelContent
        open
        shortcutLabel={null}
        view={view({
          credits: {
            availableCount: 3,
            nextExpiresAt: "2026-11-06T23:17:53.000Z",
            expiries: ["2026-11-06T23:17:53.000Z", "2026-11-30T19:47:22.000Z"],
          },
          environmentNowMs: NOW,
        })}
      />,
    );

    const trigger = page.getByRole("button", { name: /^3 resets · next expires/ });
    await expect.element(trigger).toBeVisible();
    await userEvent.hover(trigger);
    const list = page.getByRole("dialog", { name: "3 resets saved" });
    await expect.element(list.getByText("in 2d 22h")).toBeVisible();
    await expect.element(list.getByText("in 26d 18h")).toBeVisible();
    await expect.element(list.getByText("1 without an expiry")).toBeVisible();
  });

  it("says when the agent reports banked resets but none are left", async () => {
    await using _screen = await render(
      <AccountLimitsPanelContent
        open
        shortcutLabel={null}
        view={view({ credits: { availableCount: 0 }, environmentNowMs: NOW })}
      />,
    );

    await expect.element(page.getByText("No resets saved")).toBeVisible();
    expect(page.getByRole("button", { name: /resets ·/ }).elements()).toHaveLength(0);
  });
});
