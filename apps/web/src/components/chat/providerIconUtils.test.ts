import { describe, expect, it } from "vite-plus/test";

import { getTriggerDisplayModelNameBesideIcon } from "./providerIconUtils";

const model = (name: string) => ({ slug: name.toLowerCase(), name });

describe("model name beside its provider icon", () => {
  it("drops the provider word only for the driver whose icon shows it", () => {
    expect(getTriggerDisplayModelNameBesideIcon(model("Claude Opus 5.5"), "claudeAgent")).toBe(
      "Opus 5.5",
    );
    // Under Cursor the icon is Cursor's, so the model keeps its family name.
    expect(getTriggerDisplayModelNameBesideIcon(model("Claude Opus 5.5"), "cursor")).toBe(
      "Claude Opus 5.5",
    );
    expect(getTriggerDisplayModelNameBesideIcon(model("GPT-5.4"), "codex")).toBe("GPT-5.4");
  });
});
