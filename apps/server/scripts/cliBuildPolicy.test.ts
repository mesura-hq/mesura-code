import { describe, expect, it } from "vite-plus/test";

import { resolveWebClientBundleAction } from "./cliBuildPolicy.ts";

describe("resolveWebClientBundleAction", () => {
  it("bundles the client when the web build is present", () => {
    expect(resolveWebClientBundleAction({ webDistExists: true, allowMissingClient: false })).toBe(
      "bundle",
    );
  });

  it("fails when the web build is missing and nobody asked to skip it", () => {
    expect(resolveWebClientBundleAction({ webDistExists: false, allowMissingClient: false })).toBe(
      "fail",
    );
  });

  it("skips only when the caller opted in", () => {
    expect(resolveWebClientBundleAction({ webDistExists: false, allowMissingClient: true })).toBe(
      "skip",
    );
  });

  it("still bundles when skipping is allowed, so the flag cannot discard a real build", () => {
    expect(resolveWebClientBundleAction({ webDistExists: true, allowMissingClient: true })).toBe(
      "bundle",
    );
  });
});
