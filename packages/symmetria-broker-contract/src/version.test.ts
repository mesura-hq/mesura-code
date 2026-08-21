import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeSymmetriaProtocolVersion,
  SYMMETRIA_CONTRACT_VERSION,
  SYMMETRIA_PROTOCOL_MAJOR,
  SYMMETRIA_PROTOCOL_MINOR,
  SymmetriaProtocolVersion,
} from "./version.ts";

const decodeVersion = Schema.decodeUnknownResult(SymmetriaProtocolVersion);

describe("SymmetriaProtocolVersion", () => {
  it("decodes the supported major version", () => {
    const decoded = decodeVersion({ major: SYMMETRIA_PROTOCOL_MAJOR, minor: 0 });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("accepts any minor version on the supported major", () => {
    const decoded = decodeVersion({ major: SYMMETRIA_PROTOCOL_MAJOR, minor: 41 });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("refuses an unsupported major version", () => {
    const decoded = decodeVersion({ major: SYMMETRIA_PROTOCOL_MAJOR + 1, minor: 0 });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("refuses a negative or fractional minor version", () => {
    expect(Result.isFailure(decodeVersion({ major: SYMMETRIA_PROTOCOL_MAJOR, minor: -1 }))).toBe(
      true,
    );
    expect(Result.isFailure(decodeVersion({ major: SYMMETRIA_PROTOCOL_MAJOR, minor: 1.5 }))).toBe(
      true,
    );
  });
});

describe("decodeSymmetriaProtocolVersion", () => {
  it("returns the version when the major is supported", () => {
    const gated = decodeSymmetriaProtocolVersion({
      major: SYMMETRIA_PROTOCOL_MAJOR,
      minor: SYMMETRIA_PROTOCOL_MINOR,
    });
    expect(Result.isSuccess(gated)).toBe(true);
    if (Result.isSuccess(gated)) {
      expect(gated.success).toEqual({
        major: SYMMETRIA_PROTOCOL_MAJOR,
        minor: SYMMETRIA_PROTOCOL_MINOR,
      });
    }
  });

  it("names both majors when the peer speaks an unsupported one", () => {
    const gated = decodeSymmetriaProtocolVersion({ major: SYMMETRIA_PROTOCOL_MAJOR + 1, minor: 7 });
    expect(Result.isFailure(gated)).toBe(true);
    if (Result.isFailure(gated)) {
      expect(gated.failure).toEqual({
        _tag: "SymmetriaProtocolVersionMismatch",
        supportedMajor: SYMMETRIA_PROTOCOL_MAJOR,
        receivedMajor: SYMMETRIA_PROTOCOL_MAJOR + 1,
      });
    }
  });

  it("reports a payload that is not a version pair as malformed", () => {
    const gated = decodeSymmetriaProtocolVersion({ major: "one" });
    expect(Result.isFailure(gated)).toBe(true);
    if (Result.isFailure(gated)) {
      expect(gated.failure._tag).toBe("SymmetriaProtocolVersionMalformed");
    }
  });
});

describe("SYMMETRIA_CONTRACT_VERSION", () => {
  it("states a semantic version whose major matches the protocol major", () => {
    expect(SYMMETRIA_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SYMMETRIA_CONTRACT_VERSION.split(".")[0]).toBe(String(SYMMETRIA_PROTOCOL_MAJOR));
  });
});
