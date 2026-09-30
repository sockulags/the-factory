import type { PermissionOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { decidePermission, resolveInside } from "../src/policy.js";

const options: PermissionOption[] = [
  { optionId: "a1", name: "Allow", kind: "allow_once" },
  { optionId: "aa", name: "Always", kind: "allow_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
];

describe("decidePermission", () => {
  it("allows everything once in write mode", () => {
    expect(decidePermission("write", "execute", options)).toEqual({
      outcome: "selected",
      optionId: "a1",
    });
  });
  it("allows reads but rejects edits and commands in read-only mode", () => {
    expect(decidePermission("read-only", "read", options)).toEqual({
      outcome: "selected",
      optionId: "a1",
    });
    expect(decidePermission("read-only", "edit", options)).toEqual({
      outcome: "selected",
      optionId: "r1",
    });
    expect(decidePermission("read-only", "execute", options)).toEqual({
      outcome: "selected",
      optionId: "r1",
    });
    expect(decidePermission("read-only", undefined, options)).toEqual({
      outcome: "selected",
      optionId: "r1",
    });
  });
  it("falls back to other option kinds, then cancels", () => {
    const onlyAlways: PermissionOption[] = [
      { optionId: "aa", name: "Always", kind: "allow_always" },
    ];
    expect(decidePermission("write", "edit", onlyAlways)).toEqual({
      outcome: "selected",
      optionId: "aa",
    });
    expect(decidePermission("read-only", "edit", onlyAlways)).toEqual({ outcome: "cancelled" });
  });
});

describe("resolveInside", () => {
  const root = path("/work/repo");
  it("accepts paths inside the root", () => {
    expect(resolveInside([root], path("/work/repo/src/a.ts"))).toBe(path("/work/repo/src/a.ts"));
    expect(resolveInside([root], root)).toBe(root);
  });
  it("rejects escapes, siblings and relative paths", () => {
    expect(resolveInside([root], path("/work/repo/../secret"))).toBeNull();
    expect(resolveInside([root], path("/work/repo-other/x"))).toBeNull();
    expect(resolveInside([root], "src/a.ts")).toBeNull();
  });
});

function path(p: string): string {
  return process.platform === "win32" ? `C:${p.replace(/\//g, "\\")}` : p;
}
