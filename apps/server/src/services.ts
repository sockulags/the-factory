import path from "node:path";
import {
  Board,
  loadWorkflows,
  ThreadService,
  type WorkflowDefinition,
  WorkflowEngine,
} from "@factory/core";
import type { Db } from "@factory/db";
import { type AgentSpec, LocalRunner, loadAgents, type Runner } from "@factory/runner";
import type { ServerConfig } from "./config.js";

/** Tells SSE clients that a card changed so they refetch it. */
export class ChangeBus {
  private readonly listeners = new Set<(cardId: string) => void>();
  on(listener: (cardId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cardChanged(cardId: string): void {
    for (const l of this.listeners) l(cardId);
  }
}

export interface FactoryServices {
  board: Board;
  threads: ThreadService;
  engine: WorkflowEngine;
  runner: Runner;
  workflows: Map<string, WorkflowDefinition>;
  agents: AgentSpec[];
  bus: ChangeBus;
}

export async function createFactoryServices(opts: {
  db: Db;
  config: ServerConfig;
  /** Tests inject agents/runner; production loads them from config. */
  agents?: AgentSpec[];
  runner?: Runner;
}): Promise<FactoryServices> {
  const { db, config } = opts;
  const agents = opts.agents ?? (await loadAgents(config.AGENTS_CONFIG));
  const runner = opts.runner ?? new LocalRunner(agents);
  const workflows = await loadWorkflows(
    path.resolve(config.WORKFLOWS_DIR),
    agents.map((a) => a.id),
  );
  const bus = new ChangeBus();
  const board = new Board(db);
  const threads = new ThreadService({
    db,
    runner,
    turnTimeoutMs: config.TURN_TIMEOUT_MINUTES * 60_000,
    handoverFor: (id) => board.handoverForThread(id),
  });
  const engine = new WorkflowEngine({
    board,
    threads,
    runner,
    workflows,
    worktreesDir: path.resolve(config.WORKTREES_DIR),
    onCardChange: (id) => bus.cardChanged(id),
  });
  return { board, threads, engine, runner, workflows, agents, bus };
}
