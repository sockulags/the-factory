import type { DiffSummary } from "@factory/runner";
import type { ThreadEvent, TurnMode } from "./events.js";

/** Marks our context so it can't be confused with the user's actual request. */
export const CONTEXT_OPEN = "<factory-context>";
export const CONTEXT_CLOSE = "</factory-context>";

const MAX_QUOTE = 2000;
const REHYDRATE_BUDGET = 12_000;

export interface ContextInput {
  agentId: string;
  mode: TurnMode;
  /** The user's new message. */
  message: string;
  /**
   * delta:     the agent has its session; `events` are what happened since its cursor.
   * rehydrate: the agent starts a fresh session; `events` are the thread so far.
   */
  kind: "delta" | "rehydrate";
  events: ThreadEvent[];
  /** Changes in the worktree the agent hasn't seen (since its last turn / thread start). */
  diff: { from: string; summary: DiffSummary } | null;
  /** Latest step handover, if any (phase 3). Used when rehydrating. */
  handover?: string | null;
  names?: Record<string, string>;
}

/**
 * Builds what an agent receives for a turn. The agent keeps its own session, so we only
 * send what it hasn't seen: other people's messages, other agents' replies, and which
 * files changed. When it has no usable session we send a compact recap instead.
 */
export function buildTurnPrompt(input: ContextInput): string {
  const sections: string[] = [];
  const name = (actor: string) => {
    const id = actor.includes(":") ? actor.slice(actor.indexOf(":") + 1) : actor;
    return input.names?.[id] ?? id;
  };

  const conversation = input.events.filter(
    (e) => e.kind === "user_message" || e.kind === "agent_message",
  );
  if (input.kind === "rehydrate" && (conversation.length > 0 || input.handover)) {
    sections.push(
      "You are joining an ongoing thread in The Factory. Other agents and people have worked on it before you. Here is what you need to catch up.",
    );
    if (input.handover) sections.push(`Latest handover:\n${input.handover.trim()}`);
    const history = recap(conversation, name, REHYDRATE_BUDGET);
    if (history.count) {
      const note = history.truncated ? ", earlier messages omitted" : "";
      sections.push(`Conversation so far (oldest first${note}):\n${history.text}`);
    }
  } else if (input.kind === "delta") {
    const lines = conversation
      .filter((e) => !(e.kind === "agent_message" && e.actor === `agent:${input.agentId}`))
      .map((e) => describe(e, name, MAX_QUOTE));
    if (lines.length) sections.push(`Since your last turn:\n${lines.join("\n")}`);
  }

  if (input.diff && input.diff.summary.files.length > 0) {
    const n = input.diff.summary.files.length;
    sections.push(
      `${n} file${n === 1 ? "" : "s"} changed in the worktree since ${input.kind === "delta" ? "your last turn" : "the thread started"}:\n${input.diff.summary.stat}\nRun \`git diff ${input.diff.from}\` to see the changes.`,
    );
  }

  if (input.mode === "consult") {
    sections.push(
      "You are being consulted in read-only mode. Do not modify files or run commands that change anything; answer with your analysis or advice.",
    );
  }

  if (!sections.length) return input.message;
  return `${CONTEXT_OPEN}\n${sections.join("\n\n")}\n${CONTEXT_CLOSE}\n\n${input.message}`;
}

function describe(e: ThreadEvent, name: (actor: string) => string, max: number): string {
  if (e.kind === "user_message") {
    const to =
      e.payload.mode === "consult" ? `asked ${name(e.payload.to)}` : `to ${name(e.payload.to)}`;
    return `- ${name(e.actor)} (${to}): ${quote(e.payload.text, max)}`;
  }
  if (e.kind === "agent_message") {
    const changed = e.payload.changes.length
      ? ` [changed ${e.payload.changes.map((c) => c.path).join(", ")}]`
      : "";
    return `- ${name(e.actor)} replied${changed}: ${quote(e.payload.text, max)}`;
  }
  return "";
}

/** Newest messages that fit the budget, oldest first. */
function recap(events: ThreadEvent[], name: (actor: string) => string, budget: number) {
  const picked: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    const line = describe(event, name, MAX_QUOTE);
    if (used + line.length > budget && picked.length > 0) {
      truncated = true;
      break;
    }
    picked.push(line);
    used += line.length;
  }
  return { text: picked.reverse().join("\n"), truncated, count: picked.length };
}

function quote(text: string, max: number): string {
  const clean = text.trim();
  const clipped = clean.length > max ? `${clean.slice(0, max)}… [truncated]` : clean;
  return clipped.includes("\n") ? `\n  ${clipped.split("\n").join("\n  ")}` : `"${clipped}"`;
}
