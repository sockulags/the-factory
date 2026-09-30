import type { SessionMode } from "@factory/runner";

/** Consult = read-only turn by a non-driver agent. Write = the agent drives the worktree. */
export type TurnMode = "write" | "consult";

export const toSessionMode = (mode: TurnMode): SessionMode =>
  mode === "write" ? "write" : "read-only";

export interface UserMessagePayload {
  text: string;
  /** Agent the message is addressed to. */
  to: string;
  mode: TurnMode;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface AgentMessagePayload {
  text: string;
  mode: TurnMode;
  stopReason: string;
  /** How the provider session was obtained for this turn (live, loaded, resumed, new). */
  sessionOrigin: string;
  /** Exactly what we sent the agent (context preamble + message). */
  sent: string;
  toolCalls: { title: string; kind: string | null }[];
  permissions: { title: string; kind: string | null; decision: string }[];
  /** Files changed in the worktree during this turn (from checkpoints). */
  changes: FileChange[];
  checkpoint: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  contextUsage: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
  } | null;
  durationMs: number;
}

export interface ErrorPayload {
  message: string;
  to?: string;
}

export type ThreadEventInput =
  | { kind: "user_message"; actor: string; payload: UserMessagePayload }
  | { kind: "agent_message"; actor: string; payload: AgentMessagePayload }
  | { kind: "error"; actor: string; payload: ErrorPayload };

export type ThreadEvent = ThreadEventInput & {
  id: string;
  threadId: string;
  seq: number;
  createdAt: Date;
};

export const userActor = (userId: string | null | undefined) =>
  userId ? `user:${userId}` : "user:local";
export const agentActor = (agentId: string) => `agent:${agentId}`;
export const actorAgentId = (actor: string) => (actor.startsWith("agent:") ? actor.slice(6) : null);
