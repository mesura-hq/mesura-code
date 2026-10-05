import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  INITIAL_USAGE_PEEK_STATE,
  transitionUsagePeekKeyDown,
} from "~/components/sidebar/AccountLimitsPanel.logic";
import { resolveShortcutCommand } from "~/keybindings";
import { useDictationSessionStore } from "./dictationSessionStore";

/**
 * Alt+S is both the Hosts dock's held peek and dictation's save mode. The dictation rule only
 * holds while a recording or the last stopped job is live; these pin both sides of that, through
 * the same matcher the Hosts dock uses for its own chord.
 */
const LINUX = "Linux x86_64";
const altS = {
  key: "s",
  code: "KeyS",
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  getModifierState: () => false,
};

const hostsPeekHandles = () =>
  transitionUsagePeekKeyDown(
    INITIAL_USAGE_PEEK_STATE,
    altS,
    DEFAULT_RESOLVED_KEYBINDINGS,
    LINUX,
    { terminalFocus: false },
    "hosts.peek",
  ).handled;

afterEach(() => {
  useDictationSessionStore.setState({ session: null, lastJob: null });
});

describe("dictation keybindings against the Hosts peek", () => {
  it("dictation phase 4 guard: Alt+S stays the Hosts peek outside a dictation", () => {
    expect(resolveShortcutCommand(altS, DEFAULT_RESOLVED_KEYBINDINGS, { platform: LINUX })).toBe(
      "hosts.peek",
    );
    expect(hostsPeekHandles()).toBe(true);
  });

  it("dictation phase 4: Alt+S selects save while a stopped job transcribes, and the Hosts peek lets it pass", () => {
    useDictationSessionStore.setState({
      lastJob: {
        environmentId: EnvironmentId.make("dictation-keys"),
        jobId: "0d6f7c1e-2b9a-4f35-8c11-5e2a9b7d3c40" as never,
      },
    });
    expect(resolveShortcutCommand(altS, DEFAULT_RESOLVED_KEYBINDINGS, { platform: LINUX })).toBe(
      "dictation.mode.clipboard",
    );
    expect(hostsPeekHandles()).toBe(false);
  });
});
