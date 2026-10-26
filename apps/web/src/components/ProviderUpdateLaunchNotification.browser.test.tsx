import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { ToastProvider } from "./ui/toast";

const checkedAt = "2026-10-26T10:00:00.000Z";

const claudeBehindLatest: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.303",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "2.1.303",
    latestVersion: "2.1.400",
    updateCommand: "npm install -g @anthropic-ai/claude-code",
    canUpdate: true,
    checkedAt,
    message: "Update available.",
  },
};

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [claudeBehindLatest],
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => ({ environmentId: EnvironmentId.make("primary") }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/use-atom-command")>()),
  useAtomCommand: () => vi.fn(),
}));

function launchNotification() {
  return (
    <ToastProvider>
      <ProviderUpdateLaunchNotification />
    </ToastProvider>
  );
}

describe("ProviderUpdateLaunchNotification", () => {
  it("stays closed by default and opens once the provider update pop-up setting is on", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    await using screen = await render(launchNotification());
    expect(document.body.textContent).not.toContain("Update Available");

    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, providerUpdatePopup: true });
    await screen.rerender(launchNotification());
    await expect.element(page.getByText(/Update Available/i)).toBeVisible();
  });
});
