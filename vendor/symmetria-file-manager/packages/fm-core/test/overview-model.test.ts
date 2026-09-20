import { expect, it } from "vitest";
import { isAncestorPath } from "../src/overview/model.ts";

it("distinguishes siblings with a common prefix and handles filesystem root", () => {
  expect(isAncestorPath("/root/api", "/root/api-client/file")).toBe(false);
  expect(isAncestorPath("/root/api", "/root/api/file")).toBe(true);
  expect(isAncestorPath("/", "/file")).toBe(true);
});
