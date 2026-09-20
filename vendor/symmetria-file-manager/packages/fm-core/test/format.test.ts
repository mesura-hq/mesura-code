/**
 * The two formatters more than one package reads.
 *
 * They moved here because a third caller appeared in a package that cannot
 * import the second one. What is worth pinning is the boundaries — where a unit
 * changes, and what happens to the values that are not really values at all.
 */
import { describe, expect, it } from "vitest";

import { humanAge, humanSize } from "../src/format.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("humanSize", () => {
  it("leaves bytes whole and gives every larger unit one decimal", () => {
    // The asymmetry is deliberate: "1023 B" is exact and "1023.0 B" is noise,
    // while "1 kB" hides the difference between 1024 and 2047.
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(1023)).toBe("1023 B");
    expect(humanSize(1024)).toBe("1.0 kB");
  });

  it("steps up at each power of 1024", () => {
    expect(humanSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanSize(1024 ** 3)).toBe("1.0 GB");
    expect(humanSize(1024 ** 4)).toBe("1.0 TB");
  });

  it("stops at the largest unit it names rather than inventing another", () => {
    // A petabyte file is not a real case, but a wrong unit for one is a wrong
    // unit, and the loop's bound is what stops `units[unit]` being undefined.
    expect(humanSize(1024 ** 5)).toBe("1024.0 TB");
  });
});

describe("humanAge", () => {
  const now = 1_700_000_000_000;

  it("names one coarse unit, not two", () => {
    // Read at a glance beside three other facts. "3 months, 2 days ago" costs a
    // row of the preview to say what "3mo ago" says.
    expect(humanAge(now - 3 * DAY - 5 * HOUR, now)).toBe("3d ago");
  });

  it("steps through minutes, hours, days, months and years", () => {
    expect(humanAge(now - 2 * MINUTE, now)).toBe("2m ago");
    expect(humanAge(now - 5 * HOUR, now)).toBe("5h ago");
    expect(humanAge(now - 10 * DAY, now)).toBe("10d ago");
    expect(humanAge(now - 70 * DAY, now)).toBe("2mo ago");
    expect(humanAge(now - 800 * DAY, now)).toBe("2y ago");
  });

  it("says just now for anything under a minute", () => {
    expect(humanAge(now - 30 * SECOND, now)).toBe("just now");
    // Paired with a real age, so a formatter that answered "just now" to
    // everything could not pass this.
    expect(humanAge(now - 90 * SECOND, now)).toBe("1m ago");
  });

  it("reads a missing timestamp as unknown rather than as 1970", () => {
    // The engine reports no modification time for a directory, so zero is the
    // NORMAL case there. Dating every folder to the Unix epoch would be a
    // confident lie about a fact nobody asked for.
    expect(humanAge(0, now)).toBe("—");
    expect(humanAge(-1, now)).toBe("—");
  });

  it("does not say a file was modified in the future", () => {
    // A clock that disagrees with a file server, or a leap-second smear, puts a
    // modification time ahead of now. "in 4s ago" is worse than "just now".
    expect(humanAge(now + 10 * MINUTE, now)).toBe("just now");
  });
});
