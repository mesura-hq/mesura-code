// Entry point: voicePreferences.ts, the single place a call reads ClientSettings.voiceConversation.
// ThreadVoicePanel resolves a snapshot from it when a call starts; Settings writes through it.
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceCallPreferences, withVoiceLearningSpace } from "./voicePreferences";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const projectOne = ProjectId.make("project-one");
const projectTwo = ProjectId.make("project-two");

describe("voice call preferences", () => {
  it("voice learning space stays with its own environment and project", () => {
    const saved = withVoiceLearningSpace(
      DEFAULT_CLIENT_SETTINGS.voiceConversation,
      { environmentId: environmentA, projectId: projectOne },
      "software",
    );
    const spaceFor = (environmentId: EnvironmentId, projectId: ProjectId) =>
      resolveVoiceCallPreferences(saved, { environmentId, projectId }).learningSpace;

    expect(spaceFor(environmentA, projectOne)).toBe("software");
    expect(spaceFor(environmentA, projectTwo)).toBe("");
    expect(spaceFor(environmentB, projectOne)).toBe("");
    expect(spaceFor(environmentB, projectTwo)).toBe("");
  });

  it("voice learning space cleared for one project leaves the other projects intact", () => {
    const scopeOne = { environmentId: environmentA, projectId: projectOne };
    const scopeTwo = { environmentId: environmentB, projectId: projectTwo };
    const both = withVoiceLearningSpace(
      withVoiceLearningSpace(DEFAULT_CLIENT_SETTINGS.voiceConversation, scopeOne, "software"),
      scopeTwo,
      "clients",
    );
    const cleared = withVoiceLearningSpace(both, scopeOne, "   ");

    expect(resolveVoiceCallPreferences(cleared, scopeOne).learningSpace).toBe("");
    expect(resolveVoiceCallPreferences(cleared, scopeTwo).learningSpace).toBe("clients");
  });

  it("voice call preferences resolved at start do not follow later settings edits", () => {
    const scope = { environmentId: environmentA, projectId: projectOne };
    const before = { ...DEFAULT_CLIENT_SETTINGS.voiceConversation };
    const snapshot = resolveVoiceCallPreferences(before, scope);
    // A later Settings edit produces a new settings object; the running call keeps its copy.
    const edited = { ...withVoiceLearningSpace(before, scope, "later"), voice: "cedar" as const };

    expect(snapshot).toEqual({
      voice: "marin",
      language: "es",
      mode: "discuss",
      handsFree: true,
      learningSpace: "",
    });
    expect(resolveVoiceCallPreferences(edited, scope)).toMatchObject({
      voice: "cedar",
      learningSpace: "later",
    });
    expect(snapshot.voice).toBe("marin");
    expect(snapshot.learningSpace).toBe("");
  });
});
