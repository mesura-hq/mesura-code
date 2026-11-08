import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DictationJobId } from "./dictation.ts";

const decodeJobId = Schema.decodeUnknownOption(DictationJobId);

describe("DictationJobId", () => {
  it("accepts job ids inside the context-link id grammar up to 128 characters", () => {
    for (const id of ["job-1", "JOB_2", "0b7f6c2e-1d9a-4c6e-9a51-2f7d0c3b8e14", "a".repeat(128)]) {
      expect(Option.getOrNull(decodeJobId(id))).toBe(id);
    }
  });

  it("rejects job ids that a dictation marker link could not carry", () => {
    for (const id of ["", "job:7", "job/7", "job 7", "job.7", "jöb", "a".repeat(129)]) {
      expect(Option.isNone(decodeJobId(id)), id).toBe(true);
    }
  });
});
