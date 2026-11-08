import { assert, it } from "@effect/vitest";

import { resolveNightlyReleaseMetadata } from "./resolve-nightly-release.ts";

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-nightly.20260413.321",
      tag: "v9.9.10-nightly.20260413.321",
      name: "Mesura Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

it("derives preview metadata under its own prerelease identifier", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890", "preview"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-preview.20260413.321",
      tag: "v9.9.10-preview.20260413.321",
      name: "Mesura Code Preview (maintainer test build, do not install) 9.9.10-preview.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});
