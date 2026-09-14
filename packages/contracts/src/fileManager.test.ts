import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FILE_MANAGER_PUSH_CHANNELS,
  FILE_MANAGER_READ_CHANNELS,
  FILE_MANAGER_WRITE_CHANNELS,
  FileManagerEvent,
  FileManagerMutateInput,
  FileManagerQueryInput,
  FileManagerReply,
} from "./fileManager.ts";

const decodeQuery = Schema.decodeUnknownExit(FileManagerQueryInput);
const decodeMutate = Schema.decodeUnknownExit(FileManagerMutateInput);
const decodeReply = Schema.decodeUnknownExit(FileManagerReply);
const decodeEvent = Schema.decodeUnknownExit(FileManagerEvent);

describe("file manager contract", () => {
  it("accepts a read channel on the query input and keeps the payload untouched", () => {
    const payload = { path: "/tmp", showHidden: false, sort: "alphabetical", reverse: false };
    const exit = decodeQuery({ sessionId: "s1", channel: "symmetria-fm:list", payload });
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.payload).toEqual(payload);
  });

  it("refuses a write channel on the query input at decode time", () => {
    const exit = decodeQuery({ sessionId: "s1", channel: "symmetria-fm:create", payload: {} });
    expect(exit._tag).toBe("Failure");
  });

  it("refuses a read channel on the mutate input at decode time", () => {
    const exit = decodeMutate({ sessionId: "s1", channel: "symmetria-fm:list", payload: {} });
    expect(exit._tag).toBe("Failure");
  });

  it("splits every request channel into exactly one of the two sets", () => {
    const read = new Set<string>(FILE_MANAGER_READ_CHANNELS);
    for (const channel of FILE_MANAGER_WRITE_CHANNELS) expect(read.has(channel)).toBe(false);
    expect(FILE_MANAGER_WRITE_CHANNELS).toContain("symmetria-fm:transfer");
    expect(FILE_MANAGER_WRITE_CHANNELS).toContain("symmetria-fm:trash");
    expect(FILE_MANAGER_READ_CHANNELS).toContain("symmetria-fm:overview");
    expect(FILE_MANAGER_PUSH_CHANNELS).toContain("symmetria-fm:changed");
  });

  it("decodes both reply shapes and refuses a reply without an outcome", () => {
    expect(decodeReply({ ok: true, value: { entries: [] } })._tag).toBe("Success");
    expect(decodeReply({ ok: false, error: { code: "invalid_request", message: "no" } })._tag).toBe(
      "Success",
    );
    expect(decodeReply({ value: 1 })._tag).toBe("Failure");
    expect(decodeReply({ ok: false, error: { code: "typo", message: "no" } })._tag).toBe("Failure");
  });

  it("types an event by its push channel only", () => {
    expect(decodeEvent({ channel: "symmetria-fm:changed", payload: { s: 1 } })._tag).toBe(
      "Success",
    );
    expect(decodeEvent({ channel: "symmetria-fm:list", payload: {} })._tag).toBe("Failure");
  });
});
