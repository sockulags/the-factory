import path from "node:path";
import {
  Board,
  builtinPlugins,
  loadWorkflows,
  PluginHost,
  ThreadService,
  type WorkflowDefinition,
  WorkflowEngine,
} from "@factory/core";
import type { Db } from "@factory/db";
import {
  type AgentSpec,
  LocalRunner,
  loadAgents,
  RemoteRunner,
  type Runner,
} from "@factory/runner";
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
  plugins: PluginHost;
  db: Db;
}

export async function createFactoryServices(opts: {
  db: Db;
  config: ServerConfig;
  /** Tests inject agents/runner; production loads them from config. */
  agents?: AgentSpec[];
  runner?: Runner;
  /** Tests inject a plugin host (fake HTTP); production uses the built-ins. */
  plugins?: PluginHost;
}): Promise<FactoryServices> {
  const { db, config } = opts;
  let agents: AgentSpec[];
  let runner: Runner;
  if (opts.runner) {
    runner = opts.runner;
    agents = opts.agents ?? [];
  } else if (config.RUNNER_URL) {
    // Agents run on the runner service; it tells us which ones it has.
    const remote = new RemoteRunner(config.RUNNER_URL, config.RUNNER_TOKEN ?? "");
    agents = (await remote.agents()).map((a) => ({ ...a, command: "", args: [] }));
    runner = remote;
  } else {
    agents = opts.agents ?? (await loadAgents(config.AGENTS_CONFIG));
    runner = new LocalRunner(agents);
  }
  const workflows = await loadWorkflows(
    path.resolve(config.WORKFLOWS_DIR),
    agents.map((a) => a.id),
  );
  const bus = new ChangeBus();
  const board = new Board(db);
  const plugins = opts.plugins ?? new PluginHost(db, builtinPlugins());
  const threads = new ThreadService({
    db,
    runner,
    turnTimeoutMs: config.TURN_TIMEOUT_MINUTES * 60_000,
    handoverFor: (id) => board.handoverForThread(id),
    mcpServersFor: async (thread) => {
      const card = thread.cardId ? await board.getCard(thread.cardId) : null;
      return card ? plugins.mcpServersFor(card.productId) : [];
    },
  });
  const engine = new WorkflowEngine({
    board,
    threads,
    runner,
    workflows,
    worktreesDir: path.resolve(config.WORKTREES_DIR),
    resolveHook: (card, name) => plugins.resolveHook(card, name),
    instructionsFor: (card) => plugins.instructionsFor(card.productId),
    onCardChange: (id) => bus.cardChanged(id),
  });
  return { board, threads, engine, runner, workflows, agents, bus, plugins, db };
}
