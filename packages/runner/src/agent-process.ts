import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type Usage,
  type UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentSpec } from "./agents.js";
import { decidePermission, resolveInside, type SessionMode } from "./policy.js";

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
    this.child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, ...spec.env },
      // Bare commands like npx are .cmd shims on Windows, which need a shell to launch.
      // Absolute paths (which may contain spaces) are spawned directly.
      shell: process.platform === "win32" && !path.isAbsolute(spec.command),
      windowsHide: true,
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

  async newSession(cwd: string, mode: SessionMode): Promise<NewSessionResponse> {
    const res = await this.guard(this.connection.newSession({ cwd, mcpServers: [] }));
    this.sessions.set(res.sessionId, { cwd, mode, turn: null, background: [] });
    return res;
  }

  /** session/load: the agent replays history as updates, collected in `replayed`. */
  async loadSession(
    sessionId: string,
    cwd: string,
    mode: SessionMode,
  ): Promise<{ response: LoadSessionResponse | undefined; replayed: SessionUpdate[] }> {
    const state: SessionState = { cwd, mode, turn: null, background: [] };
    this.sessions.set(sessionId, state);
    const response = await this.guard(
      this.connection.loadSession({ sessionId, cwd, mcpServers: [] }),
    );
    return { response: response ?? undefined, replayed: state.background };
  }

  /** session/resume: reattaches without replaying history. */
  async resumeSession(
    sessionId: string,
    cwd: string,
    mode: SessionMode,
  ): Promise<ResumeSessionResponse> {
    this.sessions.set(sessionId, { cwd, mode, turn: null, background: [] });
    return this.guard(this.connection.resumeSession({ sessionId, cwd, mcpServers: [] }));
  }

  setMode(sessionId: string, mode: SessionMode): void {
    const state = this.requireSession(sessionId);
    state.mode = mode;
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
      this.child.kill();
      const timeout = new Promise((r) => setTimeout(r, 3000));
      await Promise.race([this.exited, timeout]);
      if (!this.exitInfo) this.child.kill("SIGKILL");
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
