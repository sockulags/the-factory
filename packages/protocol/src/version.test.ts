import { describe, expect, it } from "vitest";
import { compareVersions, isVersionSupported } from "./version.js";

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.2.0", "1.10.0", -1],
    ["v2.0.0", "1.9.9", 1],
    ["1.0.0-beta.1", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-alpha", "1.0.0-beta", -1],
    ["1.0.0-beta", "1.0.0-beta.1", -1],
    ["1.0.0+build.5", "1.0.0", 0],
  ])("%s vs %s", (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe("isVersionSupported", () => {
  it("accepts equal and newer versions", () => {
    expect(isVersionSupported("0.2.0", "0.2.0")).toBe(true);
    expect(isVersionSupported("0.3.0", "0.2.0")).toBe(true);
  });
  it("rejects older versions", () => {
    expect(isVersionSupported("0.1.9", "0.2.0")).toBe(false);
  });
});
