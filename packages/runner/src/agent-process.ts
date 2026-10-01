import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type Usage,
  type UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSpec } from "./agents.js";
import { decidePermission, resolveInside, type SessionMode } from "./policy.js";
import { killTree, spawnAgent } from "./spawn.js";

export interface PermissionRecord {
  title: string;
  kind: string | null;
  decision: string;
}

export interface TurnResult {
  stopReason: StopReason;
  /** Concatenated agent_message_chunk text. */
  text: string;
  usage: Usage | null;
  /** Last usage_update seen during the turn (context window + optional cost). */
  contextUsage: UsageUpdate | null;
  toolCalls: { title: string; kind: string | null }[];
  permissions: PermissionRecord[];
  /** Files written through the client fs capability. */
  writes: string[];
  deniedWrites: string[];
  updates: SessionUpdate[];
  durationMs: number;
}

interface SessionState {
  cwd: string;
  mode: SessionMode;
  /** The agent's own modes for this session (ACP session modes), if it has any. */
  agentModes: string[];
  /** The agent's mode when the session was opened: what write turns go back to. */
  baseAgentMode: string | null;
  currentAgentMode: string | null;
  turn: TurnResult | null;
  /** Updates received outside a prompt, e.g. history replay during session/load. */
  background: SessionUpdate[];
}

export interface AgentProcessOptions {
  /** Called for every session update (live streaming to the UI later). */
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  /** Extra env for the child process. */
  env?: NodeJS.ProcessEnv;
}

const STDERR_TAIL_LINES = 40;

/**
 * One ACP agent subprocess. Implements the client side of ACP: answers permission
 * requests according to each session's mode, serves file reads/writes confined to the
 * session's cwd, and collects each turn's output.
 */
export class AgentProcess {
  readonly spec: AgentSpec;
  init!: InitializeResponse;
  private readonly child: ChildProcess;
  private readonly connection: ClientSideConnection;
  private readonly sessions = new Map<string, SessionState>();
  private readonly stderrTail: string[] = [];
  private exitInfo: string | null = null;
  readonly exited: Promise<void>;

  private constructor(
    spec: AgentSpec,
    private readonly options: AgentProcessOptions,
  ) {
    this.spec = spec;
    this.child = spawnAgent(spec.command, spec.args, {
      ...process.env,
      ...options.env,
      ...spec.env,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitInfo = `exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
        resolve();
      });
      this.child.once("error", (err) => {
        this.exitInfo = `failed to start: ${err.message}`;
        resolve();
      });
    });
    this.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrTail.push(...chunk.split("\n").filter(Boolean));
      this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - STDERR_TAIL_LINES));
    });
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin as Writable) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout as Readable) as ReadableStream<Uint8Array>,
    );
    this.connection = new ClientSideConnection(() => this.clientHandlers(), stream);
  }

  static async start(spec: AgentSpec, options: AgentProcessOptions = {}): Promise<AgentProcess> {
    const agent = new AgentProcess(spec, options);
    agent.init = await agent.guard(
      agent.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: "the-factory", version: "0.1.0" },
      }),
    );
    return agent;
  }

  /** Last lines the agent wrote to stderr, for diagnostics. */
  get stderr(): string {
    return this.stderrTail.join("\n");
  }

  async newSession(
    cwd: string,
    mode: SessionMode,
    mcpServers: McpServer[] = [],
  ): Promise<NewSessionResponse> {
    const res = await this.guard(this.connection.newSession({ cwd, mcpServers }));
    const state = this.newState(cwd, mode);
    this.sessions.set(res.sessionId, state);
    this.recordModes(state, res.modes);
    await this.applyAgentMode(res.sessionId, state);
    return res;
  }

  /** session/load: the agent replays history as updates, collected in `replayed`. */
  async loadSession(
    sessionId: string,
    cwd: string,
    mode: SessionMode,
    mcpServers: McpServer[] = [],
  ): Promise<{ response: LoadSessionResponse | undefined; replayed: SessionUpdate[] }> {
    const state = this.newState(cwd, mode);
    this.sessions.set(sessionId, state);
    const response = await this.guard(this.connection.loadSession({ sessionId, cwd, mcpServers }));
    this.recordModes(state, response?.modes);
    await this.applyAgentMode(sessionId, state);
    return { response: response ?? undefined, replayed: state.background };
  }

  /** session/resume: reattaches without replaying history. */
  async resumeSession(
    sessionId: string,
    cwd: string,
    mode: SessionMode,
    mcpServers: McpServer[] = [],
  ): Promise<ResumeSessionResponse> {
    const state = this.newState(cwd, mode);
    this.sessions.set(sessionId, state);
    const response = await this.guard(
      this.connection.resumeSession({ sessionId, cwd, mcpServers }),
    );
    this.recordModes(state, response.modes);
    await this.applyAgentMode(sessionId, state);
    return response;
  }

  /**
   * Sets the turn mode. Our permission policy enforces it for agents that ask before
   * acting; for agents with their own read-only mode we also switch the agent's mode,
   * since some agents (e.g. Codex) write without asking.
   */
  async setMode(sessionId: string, mode: SessionMode): Promise<void> {
    const state = this.requireSession(sessionId);
    state.mode = mode;
    await this.applyAgentMode(sessionId, state);
  }

  /** The agent's own session mode currently in effect, if it has modes. */
  agentMode(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.currentAgentMode ?? null;
  }

  private newState(cwd: string, mode: SessionMode): SessionState {
    return {
      cwd,
      mode,
      agentModes: [],
      baseAgentMode: null,
      currentAgentMode: null,
      turn: null,
      background: [],
    };
  }

  private recordModes(state: SessionState, modes: SessionModeState | null | undefined): void {
    if (!modes) return;
    state.agentModes = modes.availableModes.map((m) => m.id);
    state.currentAgentMode = modes.currentModeId;
    // If the session was left in a read-only mode, don't treat that as its normal mode.
    state.baseAgentMode = isReadOnlyMode(modes.currentModeId)
      ? (state.agentModes.find((id) => !isReadOnlyMode(id)) ?? null)
      : modes.currentModeId;
  }

  private agentModeFor(state: SessionState): string | null {
    const has = (id: string | undefined) => (id && state.agentModes.includes(id) ? id : null);
    if (state.mode === "read-only") {
      return has(this.spec.modes?.consult) ?? state.agentModes.find(isReadOnlyMode) ?? null;
    }
    return has(this.spec.modes?.write) ?? state.baseAgentMode;
  }

  private async applyAgentMode(sessionId: string, state: SessionState): Promise<void> {
    const target = this.agentModeFor(state);
    if (!target || target === state.currentAgentMode) return;
    await this.guard(this.connection.setSessionMode({ sessionId, modeId: target }));
    state.currentAgentMode = target;
  }

  async setAgentMode(sessionId: string, modeId: string): Promise<void> {
    await this.guard(this.connection.setSessionMode({ sessionId, modeId }));
  }

  /** Sends one user message and waits for the turn to end (or `timeoutMs`, then cancels). */
  async prompt(
    sessionId: string,
    text: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<TurnResult> {
    const state = this.requireSession(sessionId);
    const turn: TurnResult = {
      stopReason: "end_turn",
      text: "",
      usage: null,
      contextUsage: null,
      toolCalls: [],
      permissions: [],
      writes: [],
      deniedWrites: [],
      updates: [],
      durationMs: 0,
    };
    state.turn = turn;
    const started = Date.now();
    const timer = opts.timeoutMs
      ? setTimeout(() => void this.cancel(sessionId), opts.timeoutMs)
      : undefined;
    try {
      const res = await this.guard(
        this.connection.prompt({ sessionId, prompt: [{ type: "text", text }] }),
      );
      turn.stopReason = res.stopReason;
      turn.usage = res.usage ?? null;
      return turn;
    } finally {
      clearTimeout(timer);
      turn.durationMs = Date.now() - started;
      state.turn = null;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.cancel({ sessionId }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.exitInfo) {
      this.child.stdin?.end();
      killTree(this.child);
      const timeout = new Promise((r) => setTimeout(r, 3000));
      await Promise.race([this.exited, timeout]);
      if (!this.exitInfo) killTree(this.child, true);
    }
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`unknown session ${sessionId}`);
    return state;
  }

  /** Rejects with a useful message if the process dies while a request is pending. */
  private async guard<T>(request: Promise<T>): Promise<T> {
    const died = this.exited.then(() => {
      throw new Error(`${this.spec.name} ${this.exitInfo}.\n${this.stderr}`.trim());
    });
    return Promise.race([request, died]);
  }

  private clientHandlers(): Client {
    return {
      sessionUpdate: (n: SessionNotification) => this.onSessionUpdate(n),
      requestPermission: (req) => this.onPermission(req),
      readTextFile: async ({ sessionId, path: filePath, line, limit }) => {
        const state = this.requireSession(sessionId);
        const resolved = resolveInside([state.cwd], filePath);
        if (!resolved)
          throw RequestError.invalidParams({ path: filePath }, "path is outside the workspace");
        let content: string;
        try {
          content = await readFile(resolved, "utf8");
        } catch {
          throw RequestError.resourceNotFound(filePath);
        }
        if (line != null || limit != null) {
          const lines = content.split("\n");
          const start = Math.max(0, (line ?? 1) - 1);
          content = lines.slice(start, limit != null ? start + limit : undefined).join("\n");
        }
        return { content };
      },
      writeTextFile: async ({ sessionId, path: filePath, content }) => {
        const state = this.requireSession(sessionId);
        const resolved = resolveInside([state.cwd], filePath);
        if (!resolved || state.mode === "read-only") {
          state.turn?.deniedWrites.push(filePath);
          throw new RequestError(
            -32000,
            resolved
              ? "read-only session: writes are not allowed"
              : "path is outside the workspace",
          );
        }
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content);
        state.turn?.writes.push(path.relative(state.cwd, resolved));
        return {};
      },
    };
  }

  private onSessionUpdate({ sessionId, update }: SessionNotification): void {
    this.options.onUpdate?.(sessionId, update);
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (update.sessionUpdate === "current_mode_update")
      state.currentAgentMode = update.currentModeId;
    const turn = state.turn;
    if (!turn) {
      state.background.push(update);
      return;
    }
    turn.updates.push(update);
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") turn.text += update.content.text;
        break;
      case "tool_call":
        turn.toolCalls.push({ title: update.title, kind: update.kind ?? null });
        break;
      case "usage_update":
        turn.contextUsage = update;
        break;
    }
  }

  private onPermission(req: RequestPermissionRequest): RequestPermissionResponse {
    const state = this.sessions.get(req.sessionId);
    const kind = req.toolCall.kind ?? null;
    const decision = decidePermission(state?.mode ?? "read-only", kind, req.options);
    const chosen =
      decision.outcome === "selected"
        ? (req.options.find((o) => o.optionId === decision.optionId)?.kind ?? "?")
        : "cancelled";
    state?.turn?.permissions.push({
      title: req.toolCall.title ?? "(untitled)",
      kind,
      decision: chosen,
    });
    return { outcome: decision };
  }
}

const isReadOnlyMode = (id: string) => /read[-_ ]?only/i.test(id);
