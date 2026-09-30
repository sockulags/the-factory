import { describe, expect, it } from "vitest";
import { buildTurnPrompt } from "../src/context.js";
import type { ThreadEvent } from "../src/events.js";

let seq = 0;
const user = (text: string, to = "alpha", mode: "write" | "consult" = "write"): ThreadEvent => ({
  id: `e${++seq}`,
  threadId: "t",
  seq,
  createdAt: new Date(),
  kind: "user_message",
  actor: "user:u1",
  payload: { text, to, mode },
});
const agent = (id: string, text: string, changes: string[] = []): ThreadEvent => ({
  id: `e${++seq}`,
  threadId: "t",
  seq,
  createdAt: new Date(),
  kind: "agent_message",
  actor: `agent:${id}`,
  payload: {
    text,
    mode: "write",
    stopReason: "end_turn",
    sessionOrigin: "live",
    sent: "",
    toolCalls: [],
    permissions: [],
    changes: changes.map((p) => ({ path: p, added: 1, removed: 0 })),
    checkpoint: null,
    usage: null,
    contextUsage: null,
    durationMs: 1,
  },
});

describe("buildTurnPrompt", () => {
  it("passes the message through when there is nothing new", () => {
    expect(
      buildTurnPrompt({
        agentId: "a",
        mode: "write",
        message: "go",
        kind: "delta",
        events: [],
        diff: null,
      }),
    ).toBe("go");
  });

  it("uses display names, marks consults, and skips the agent's own replies in a delta", () => {
    const prompt = buildTurnPrompt({
      agentId: "alpha",
      mode: "write",
      message: "continue",
      kind: "delta",
      events: [
        agent("alpha", "my own reply"),
        user("what do you think?", "beta", "consult"),
        agent("beta", "use a queue", ["q.ts"]),
      ],
      diff: null,
      names: { u1: "Lucas", beta: "Codex" },
    });
    expect(prompt).toContain('Lucas (asked Codex): "what do you think?"');
    expect(prompt).toContain('Codex replied [changed q.ts]: "use a queue"');
    expect(prompt).not.toContain("my own reply");
  });

  it("truncates long quotes and keeps multi-line replies readable", () => {
    const prompt = buildTurnPrompt({
      agentId: "alpha",
      mode: "write",
      message: "ok",
      kind: "delta",
      events: [agent("beta", "x".repeat(3000)), agent("beta", "line 1\nline 2")],
      diff: null,
    });
    expect(prompt).toContain("… [truncated]");
    expect(prompt).toContain("\n  line 1\n  line 2");
  });

  it("adds the read-only notice for consults even without other context", () => {
    const prompt = buildTurnPrompt({
      agentId: "a",
      mode: "consult",
      message: "review?",
      kind: "delta",
      events: [],
      diff: null,
    });
    expect(prompt).toContain("read-only mode");
    expect(prompt.endsWith("\n\nreview?")).toBe(true);
  });

  it("rehydrates with the handover and the newest messages within budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => user(`message ${i} ${"y".repeat(500)}`));
    const prompt = buildTurnPrompt({
      agentId: "beta",
      mode: "write",
      message: "take over",
      kind: "rehydrate",
      events: many,
      diff: null,
      handover: "Goal: fix login.",
    });
    expect(prompt).toContain("Latest handover:\nGoal: fix login.");
    expect(prompt).toContain("earlier messages omitted");
    expect(prompt).toContain("message 39");
    expect(prompt).not.toContain("message 0 ");
  });
});
