import type { McpServer, SessionUpdate } from "@agentclientprotocol/sdk";
import { AgentProcess, type TurnResult } from "./agent-process.js";
import type { AgentSpec } from "./agents.js";
import { type DocFile, readDocs } from "./docs.js";
import { type ExecResult, runCommand } from "./exec.js";
import {
  checkpoint,
  commitAll,
  type DiffSummary,
  deleteRefs,
  diffPatch,
  diffSummary,
  ensureWorktree,
  isGitRepo,
  type PushAuth,
  pushBranch,
  remoteUrl,
  removeWorktree,
  restorePaths,
} from "./git.js";
import type { SessionMode } from "./policy.js";

/**
 * How a session was obtained:
 *  live    - still open in a running agent process
 *  loaded  - reattached with session/load (agent replayed history)
 *  resumed - reattached with session/resume
 *  new     - a fresh session; the agent remembers nothing of the thread
 */
export type SessionOrigin = "live" | "loaded" | "resumed" | "new";

export interface OpenSessionRequest {
  agentId: string;
  cwd: string;
  mode: SessionMode;
  /** Provider session to reattach to, if the thread has one for this agent. */
  existingSessionId?: string | null;
  /** Tools for the agent (from plugins), e.g. an issue tracker's MCP server. */
  mcpServers?: McpServer[];
}

/**
 * Executes agent turns and owns worktrees. The server talks to it through this interface
 * only, so it can run in-process (now), in a pod, or on a developer's machine (later).
 */
export interface Runner {
  openSession(req: OpenSessionRequest): Promise<{ sessionId: string; origin: SessionOrigin }>;
  prompt(req: {
    agentId: string;
    sessionId: string;
    mode: SessionMode;
    text: string;
    timeoutMs?: number;
    onUpdate?: (update: SessionUpdate) => void;
  }): Promise<TurnResult>;
  cancel(agentId: string, sessionId: string): Promise<void>;
  /** Snapshot of the worktree; null when `cwd` is not a git repo. */
  checkpoint(cwd: string, ref: string, message: string): Promise<string | null>;
  diff(cwd: string, from: string, to: string): Promise<DiffSummary>;
  /** Creates the card's worktree on `branch` from `base` if it doesn't exist yet. */
  ensureWorktree(req: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    base: string;
  }): Promise<void>;
  /** Removes the worktree and the Factory's hidden refs under each of `refPrefixes`. */
  removeWorktree(req: {
    repoPath: string;
    worktreePath: string;
    refPrefixes?: string[];
  }): Promise<void>;
  exec(command: string, cwd: string, timeoutMs?: number): Promise<ExecResult>;
  /** Commits all changes in the worktree; null if there was nothing to commit. */
  commitAll(cwd: string, message: string): Promise<string | null>;
  patch(
    cwd: string,
    from: string,
    to: string,
    paths?: string[],
  ): Promise<{ patch: string; truncated: boolean }>;
  /** Restores `paths` to their state in snapshot `source` (removes files added since). */
  restorePaths(cwd: string, source: string, paths: string[]): Promise<void>;
  readDocs(cwd: string, dir?: string): Promise<DocFile[]>;
  /** Pushes a branch to a remote (URL or path), optionally with HTTP basic credentials. */
  push(cwd: string, remote: string, branch: string, auth?: PushAuth): Promise<void>;
  remoteUrl(cwd: string, name?: string): Promise<string | null>;
  shutdown(): Promise<void>;
}

/** Runs agents as local subprocesses: one process per agent, many sessions per process. */
export class LocalRunner implements Runner {
  private readonly processes = new Map<string, Promise<AgentProcess>>();
  private readonly liveSessions = new Map<string, Set<string>>();
  private readonly listeners = new Map<string, (update: SessionUpdate) => void>();

  constructor(
    private readonly agents: AgentSpec[],
    private readonly options: { env?: NodeJS.ProcessEnv } = {},
  ) {}

  async openSession({
    agentId,
    cwd,
    mode,
    existingSessionId,
    mcpServers = [],
  }: OpenSessionRequest) {
    const agent = await this.process(agentId);
    const live = this.live(agentId);
    if (existingSessionId && live.has(existingSessionId)) {
      await agent.setMode(existingSessionId, mode);
      return { sessionId: existingSessionId, origin: "live" as const };
    }
    if (existingSessionId) {
      const caps = agent.init.agentCapabilities ?? {};
      try {
        if (caps.loadSession) {
          await agent.loadSession(existingSessionId, cwd, mode, mcpServers);
          live.add(existingSessionId);
          return { sessionId: existingSessionId, origin: "loaded" as const };
        }
        if (caps.sessionCapabilities?.resume) {
          await agent.resumeSession(existingSessionId, cwd, mode, mcpServers);
          live.add(existingSessionId);
          return { sessionId: existingSessionId, origin: "resumed" as const };
        }
      } catch {
        // Session is gone on the provider side (expired, deleted, other machine): start fresh.
      }
    }
    const { sessionId } = await agent.newSession(cwd, mode, mcpServers);
    live.add(sessionId);
    return { sessionId, origin: "new" as const };
  }

  async prompt(req: Parameters<Runner["prompt"]>[0]): Promise<TurnResult> {
    const agent = await this.process(req.agentId);
    await agent.setMode(req.sessionId, req.mode);
    if (req.onUpdate) this.listeners.set(req.sessionId, req.onUpdate);
    try {
      return await agent.prompt(req.sessionId, req.text, { timeoutMs: req.timeoutMs });
    } finally {
      this.listeners.delete(req.sessionId);
    }
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    const agent = await this.processes.get(agentId);
    await agent?.cancel(sessionId);
  }

  async checkpoint(cwd: string, ref: string, message: string): Promise<string | null> {
    if (!(await isGitRepo(cwd))) return null;
    return checkpoint(cwd, ref, message);
  }

  diff(cwd: string, from: string, to: string): Promise<DiffSummary> {
    return diffSummary(cwd, from, to);
  }

  ensureWorktree(req: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    base: string;
  }): Promise<void> {
    return ensureWorktree(req.repoPath, req.worktreePath, req.branch, req.base);
  }

  async removeWorktree(req: {
    repoPath: string;
    worktreePath: string;
    refPrefixes?: string[];
  }): Promise<void> {
    await removeWorktree(req.repoPath, req.worktreePath);
    for (const prefix of req.refPrefixes ?? []) await deleteRefs(req.repoPath, prefix);
  }

  exec(command: string, cwd: string, timeoutMs?: number): Promise<ExecResult> {
    return runCommand(command, cwd, timeoutMs);
  }

  commitAll(cwd: string, message: string): Promise<string | null> {
    return commitAll(cwd, message);
  }

  patch(cwd: string, from: string, to: string, paths?: string[]) {
    return diffPatch(cwd, from, to, paths);
  }

  restorePaths(cwd: string, source: string, paths: string[]): Promise<void> {
    return restorePaths(cwd, source, paths);
  }

  readDocs(cwd: string, dir?: string): Promise<DocFile[]> {
    return readDocs(cwd, dir);
  }

  push(cwd: string, remote: string, branch: string, auth?: PushAuth): Promise<void> {
    return pushBranch(cwd, remote, branch, auth);
  }

  remoteUrl(cwd: string, name?: string): Promise<string | null> {
    return remoteUrl(cwd, name);
  }

  async shutdown(): Promise<void> {
    const all = await Promise.allSettled(this.processes.values());
    this.processes.clear();
    this.liveSessions.clear();
    await Promise.all(all.map((p) => (p.status === "fulfilled" ? p.value.close() : undefined)));
  }

  private live(agentId: string): Set<string> {
    let set = this.liveSessions.get(agentId);
    if (!set) {
      set = new Set();
      this.liveSessions.set(agentId, set);
    }
    return set;
  }

  /** Starts the agent's process on first use and restarts it if it died. */
  private process(agentId: string): Promise<AgentProcess> {
    const existing = this.processes.get(agentId);
    if (existing) return existing;
    const spec = this.agents.find((a) => a.id === agentId);
    if (!spec) return Promise.reject(new Error(`unknown agent "${agentId}"`));
    const started = AgentProcess.start(spec, {
      env: this.options.env,
      onUpdate: (sessionId, update) => this.listeners.get(sessionId)?.(update),
    });
    this.processes.set(agentId, started);
    started.then(
      (agent) =>
        void agent.exited.then(() => {
          // Forget the dead process and its sessions; they'll be reloaded on next use.
          if (this.processes.get(agentId) === started) this.processes.delete(agentId);
          this.liveSessions.delete(agentId);
        }),
      () => this.processes.delete(agentId),
    );
    return started;
  }
}
