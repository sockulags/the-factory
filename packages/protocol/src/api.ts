// Shapes of the server's JSON API, shared by the server and the UI.
// Dates travel as ISO strings.

export type CardState = "backlog" | "running" | "awaiting_gate" | "blocked" | "done" | "closed";
export type TurnMode = "write" | "consult";
export type GateDecision = "approved" | "changes_requested";

export interface ProductDto {
  id: string;
  key: string;
  name: string;
}

export interface RepoDto {
  id: string;
  productId: string;
  name: string;
  path: string;
  defaultBranch: string;
  checks: string[];
}

export interface AgentDto {
  id: string;
  name: string;
}

export interface WorkflowStepDto {
  id: string;
  name: string;
  agent: string;
  mode: TurnMode;
  gate: "auto" | "human" | "checks";
  consult: string[];
}

export interface WorkflowDto {
  type: string;
  name: string;
  description: string;
  steps: WorkflowStepDto[];
}

export interface CardDto {
  id: string;
  key: string;
  productId: string;
  repoId: string | null;
  number: number;
  type: string;
  title: string;
  body: string;
  step: string | null;
  state: CardState;
  rank: string;
  assigneeId: string | null;
  branch: string | null;
  /** Path of the card's worktree on the runner, once created. */
  worktreePath: string | null;
  /** True while the engine has work queued/running for the card. */
  busy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CardEventDto {
  id: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface HandoverStructured {
  goal: string;
  decisions: { decision: string; why: string }[];
  rejected: { option: string; why: string }[];
  filesTouched: { path: string; why: string }[];
  verify: string[];
  openQuestions: string[];
}

export interface HandoverDto {
  id: string;
  step: string;
  threadId: string | null;
  content:
    | { format: "structured"; handover: HandoverStructured }
    | { format: "raw"; text: string; error: string };
  createdAt: string;
}

export interface ThreadSummaryDto {
  id: string;
  title: string;
  step: string | null;
  driverAgentId: string | null;
  createdAt: string;
}

export interface DocProposalDto {
  id: string;
  step: string;
  status: "pending" | "approved" | "discarded" | "superseded";
  /** Unified diff of the docs directory. */
  patch: string;
  files: FileChangeDto[];
  /** Files changed outside the docs directory during the docs step. */
  outsideDocs: string[];
  reviewedBy: string | null;
  createdAt: string;
}

export interface LinkDto {
  id: string;
  plugin: string;
  kind: string;
  ref: string;
  url: string;
  title: string | null;
}

export interface PluginDto {
  id: string;
  name: string;
  description: string;
  exampleConfig: Record<string, unknown>;
}

export interface PluginConfigDto {
  plugin: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CardDetailDto {
  card: CardDto;
  events: CardEventDto[];
  handovers: HandoverDto[];
  threads: ThreadSummaryDto[];
  docProposals: DocProposalDto[];
  links: LinkDto[];
}

export interface FileChangeDto {
  path: string;
  added: number;
  removed: number;
}

export interface AgentMessageDto {
  text: string;
  mode: TurnMode;
  stopReason: string;
  sessionOrigin: string;
  sent: string;
  toolCalls: { title: string; kind: string | null }[];
  permissions: { title: string; kind: string | null; decision: string }[];
  changes: FileChangeDto[];
  checkpoint: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  contextUsage: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
  } | null;
  durationMs: number;
}

export type ThreadEventDto = { id: string; seq: number; actor: string; createdAt: string } & (
  | { kind: "user_message"; payload: { text: string; to: string; mode: TurnMode } }
  | { kind: "agent_message"; payload: AgentMessageDto }
  | { kind: "error"; payload: { message: string; to?: string } }
);

export interface ThreadDetailDto {
  thread: ThreadSummaryDto & { cardId: string | null; cwd: string };
  events: ThreadEventDto[];
  running: boolean;
  /** Display names for actors ("user:<id>" → name). */
  names: Record<string, string>;
}

/** Streamed on GET /api/threads/:id/stream (server-sent events, `data:` = JSON). */
export type ThreadStreamEvent =
  | { type: "event"; event: ThreadEventDto }
  | { type: "turn"; state: "started" | "finished"; agentId: string }
  | { type: "chunk"; agentId: string; text: string }
  | { type: "tool"; agentId: string; title: string; kind: string | null; status: string | null };

/** Streamed on GET /api/stream: something changed, refetch what you show. */
export type BoardStreamEvent =
  | { type: "card"; cardId: string; productId: string }
  | { type: "hello" };

export interface UsageRowDto {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
}

export interface UsageReportDto {
  since: string;
  total: UsageRowDto;
  byAgent: (UsageRowDto & { agentId: string })[];
  byCard: (UsageRowDto & { cardId: string; key: string; title: string })[];
  byDay: (UsageRowDto & { day: string })[];
}
