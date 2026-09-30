import path from "node:path";
import type { PermissionOption, ToolKind } from "@agentclientprotocol/sdk";

/**
 * write:     the session's driver; may edit files and run commands.
 * read-only: a consultant; may read and search but not change anything.
 */
export type SessionMode = "write" | "read-only";

const READ_ONLY_KINDS: ReadonlySet<ToolKind> = new Set(["read", "search", "think", "fetch"]);

export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/**
 * Answers an agent's permission request according to the session mode.
 * Prefers one-time grants so every action stays individually visible in the log.
 */
export function decidePermission(
  mode: SessionMode,
  toolKind: ToolKind | null | undefined,
  options: PermissionOption[],
): PermissionDecision {
  const allowed = mode === "write" || (toolKind != null && READ_ONLY_KINDS.has(toolKind));
  const preference = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preference) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
}

/** Resolves `requested` and checks it lies inside one of `roots` (no `..` escapes). */
export function resolveInside(roots: string[], requested: string): string | null {
  if (!path.isAbsolute(requested)) return null;
  const resolved = path.resolve(requested);
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
  }
  return null;
}
