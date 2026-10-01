import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { type Db, schema } from "@factory/db";
import type { Runner } from "@factory/runner";
import { and, asc, eq, gt, inArray, max } from "drizzle-orm";
import { buildTurnPrompt } from "./context.js";
import {
  type AgentMessagePayload,
  agentActor,
  type ThreadEvent,
  type ThreadEventInput,
  type TurnMode,
  toSessionMode,
  userActor,
} from "./events.js";

const { threads, threadEvents, agentSessions, users } = schema;

export type Thread = typeof threads.$inferSelect;

/** Pushed to subscribers: persisted events, and streaming updates while a turn runs. */
export type LiveEvent =
  | { type: "event"; event: ThreadEvent }
  | { type: "update"; agentId: string; update: SessionUpdate }
  | { type: "turn"; state: "started" | "finished"; agentId: string };

export interface SendRequest {
  threadId: string;
  /** Agent to address. Switching agents between messages is the "model switch". */
  agentId: string;
  text: string;
  mode?: TurnMode;
  userId?: string | null /** Overrides the actor, e.g. "workflow" for messages the engine sends. */;
  actor?: string;
}

export interface ThreadServiceOptions {
  db: Db;
  runner: Runner;
  turnTimeoutMs?: number;
  /** Display names for agents/users in context preambles. */
  names?: Record<string, string>;
  /** Supplies the latest handover for a thread when an agent must be rehydrated (phase 3). */
  handoverFor?: (threadId: string) => Promise<string | null>;
}

const refBase = (threadId: string) => `refs/factory/threads/${threadId}`;

/**
 * Owns the canonical log of every thread and runs agent turns against it.
 *
 * Each agent keeps its own provider session per thread. Before a turn we send it only
 * what it hasn't seen (per-agent cursor + worktree diff since its last turn). If its
 * session can't be reattached, it gets a recap instead. Turns within a thread are
 * serialized; only a `write` turn may change the worktree.
 */
export class ThreadService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, { agentId: string; sessionId: string }>();
  private readonly subscribers = new Map<string, Set<(e: LiveEvent) => void>>();

  constructor(private readonly options: ThreadServiceOptions) {}

  async createThread(input: {
    title: string;
    cwd: string;
    createdBy?: string | null;
    cardId?: string | null;
    step?: string | null;
  }): Promise<Thread> {
    const [row] = await this.options.db
      .insert(threads)
      .values({
        title: input.title,
        cwd: input.cwd,
        createdBy: input.createdBy ?? null,
        cardId: input.cardId ?? null,
        step: input.step ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to create thread");
    return row;
  }

  async getThread(threadId: string): Promise<Thread | null> {
    const [row] = await this.options.db.select().from(threads).where(eq(threads.id, threadId));
    return row ?? null;
  }

  async events(threadId: string, afterSeq = 0): Promise<ThreadEvent[]> {
    const rows = await this.options.db
      .select()
      .from(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), gt(threadEvents.seq, afterSeq)))
      .orderBy(asc(threadEvents.seq));
    return rows as ThreadEvent[];
  }

  async sessions(threadId: string) {
    return this.options.db.select().from(agentSessions).where(eq(agentSessions.threadId, threadId));
  }

  /** Display names keyed by user id, for the users who appear in `events`. */
  async userNames(events: ThreadEvent[]): Promise<Record<string, string>> {
    const ids = [
      ...new Set(
        events
          .map((e) => e.actor)
          .filter((a) => a.startsWith("user:") && a !== "user:local")
          .map((a) => a.slice(5)),
      ),
    ].filter((id) => /^[0-9a-f-]{36}$/.test(id));
    if (!ids.length) return {};
    const rows = await this.options.db.select().from(users).where(inArray(users.id, ids));
    return Object.fromEntries(rows.map((u) => [u.id, u.name ?? u.username]));
  }

  subscribe(threadId: string, listener: (e: LiveEvent) => void): () => void {
    let set = this.subscribers.get(threadId);
    if (!set) {
      set = new Set();
      this.subscribers.set(threadId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  /** Stops the turn currently running in the thread, if any. */
  async cancel(threadId: string): Promise<void> {
    const current = this.running.get(threadId);
    if (current) await this.options.runner.cancel(current.agentId, current.sessionId);
  }

  /** Posts a user message to an agent and runs its turn. Queued behind any running turn. */
  send(req: SendRequest): Promise<ThreadEvent> {
    const previous = this.queues.get(req.threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.runTurn(req));
    this.queues.set(req.threadId, next);
    const cleanup = () => {
      if (this.queues.get(req.threadId) === next) this.queues.delete(req.threadId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async runTurn(req: SendRequest): Promise<ThreadEvent> {
    const { db, runner } = this.options;
    const mode: TurnMode = req.mode ?? "write";
    const thread = await this.getThread(req.threadId);
    if (!thread) throw new Error(`unknown thread ${req.threadId}`);

    const userEvent = await this.append(thread.id, {
      kind: "user_message",
      actor: req.actor ?? userActor(req.userId),
      payload: { text: req.text, to: req.agentId, mode },
    });

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.threadId, thread.id), eq(agentSessions.agentId, req.agentId)));

    try {
      const before = await runner.checkpoint(
        thread.cwd,
        `${refBase(thread.id)}/${userEvent.seq}-before`,
        "before turn",
      );
      const opened = await runner.openSession({
        agentId: req.agentId,
        cwd: thread.cwd,
        mode: toSessionMode(mode),
        existingSessionId: session?.acpSessionId,
      });

      // Continuing its own session → delta since its cursor. Fresh session → recap.
      const continuing = opened.origin !== "new" && session != null;
      const history = await this.events(thread.id, continuing ? session.cursorSeq : 0);
      const unseen = history.filter((e) => e.seq < userEvent.seq);
      const diffFrom = continuing ? session.lastCheckpoint : await this.firstCheckpoint(thread.id);
      const diff =
        diffFrom && before && diffFrom !== before
          ? { from: diffFrom, summary: await runner.diff(thread.cwd, diffFrom, before) }
          : null;
      const sent = buildTurnPrompt({
        agentId: req.agentId,
        mode,
        message: req.text,
        kind: continuing ? "delta" : "rehydrate",
        events: unseen,
        diff,
        handover: continuing ? null : await this.options.handoverFor?.(thread.id),
        names: { ...this.options.names, ...(await this.userNames(unseen)) },
      });

      if (mode === "write" && thread.driverAgentId !== req.agentId) {
        await db
          .update(threads)
          .set({ driverAgentId: req.agentId })
          .where(eq(threads.id, thread.id));
      }

      this.running.set(thread.id, { agentId: req.agentId, sessionId: opened.sessionId });
      this.emit(thread.id, { type: "turn", state: "started", agentId: req.agentId });
      let turn: Awaited<ReturnType<Runner["prompt"]>>;
      try {
        turn = await runner.prompt({
          agentId: req.agentId,
          sessionId: opened.sessionId,
          mode: toSessionMode(mode),
          text: sent,
          timeoutMs: this.options.turnTimeoutMs,
          onUpdate: (update) =>
            this.emit(thread.id, { type: "update", agentId: req.agentId, update }),
        });
      } finally {
        this.running.delete(thread.id);
        this.emit(thread.id, { type: "turn", state: "finished", agentId: req.agentId });
      }

      const after = await runner.checkpoint(
        thread.cwd,
        `${refBase(thread.id)}/${userEvent.seq}-after`,
        "after turn",
      );
      const changes =
        before && after && before !== after
          ? (await runner.diff(thread.cwd, before, after)).files
          : [];

      const payload: AgentMessagePayload = {
        text: turn.text,
        mode,
        stopReason: turn.stopReason,
        sessionOrigin: opened.origin,
        sent,
        toolCalls: turn.toolCalls,
        permissions: turn.permissions,
        changes,
        checkpoint: after,
        usage: turn.usage
          ? {
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
              totalTokens: turn.usage.totalTokens,
            }
          : null,
        contextUsage: turn.contextUsage
          ? {
              used: turn.contextUsage.used,
              size: turn.contextUsage.size,
              cost: turn.contextUsage.cost ?? null,
            }
          : null,
        durationMs: turn.durationMs,
      };
      const agentEvent = await this.append(thread.id, {
        kind: "agent_message",
        actor: agentActor(req.agentId),
        payload,
      });

      await db
        .insert(agentSessions)
        .values({
          threadId: thread.id,
          agentId: req.agentId,
          acpSessionId: opened.sessionId,
          cursorSeq: agentEvent.seq,
          lastCheckpoint: after,
        })
        .onConflictDoUpdate({
          target: [agentSessions.threadId, agentSessions.agentId],
          set: {
            acpSessionId: opened.sessionId,
            cursorSeq: agentEvent.seq,
            lastCheckpoint: after,
            updatedAt: new Date(),
          },
        });
      return agentEvent;
    } catch (err) {
      // The cursor is not advanced, so the agent gets this message again in its next delta.
      await this.append(thread.id, {
        kind: "error",
        actor: agentActor(req.agentId),
        payload: { message: (err as Error).message, to: req.agentId },
      });
      throw err;
    }
  }

  /** Earliest snapshot in the thread: the baseline for "what changed" when rehydrating. */
  private async firstCheckpoint(threadId: string): Promise<string | null> {
    const events = await this.events(threadId);
    for (const e of events) {
      if (e.kind === "agent_message" && e.payload.checkpoint) return e.payload.checkpoint;
    }
    return null;
  }

  private async append(threadId: string, input: ThreadEventInput): Promise<ThreadEvent> {
    const { db } = this.options;
    const [current] = await db
      .select({ seq: max(threadEvents.seq) })
      .from(threadEvents)
      .where(eq(threadEvents.threadId, threadId));
    const [row] = await db
      .insert(threadEvents)
      .values({
        threadId,
        seq: (current?.seq ?? 0) + 1,
        kind: input.kind,
        actor: input.actor,
        payload: input.payload,
      })
      .returning();
    const event = row as ThreadEvent;
    this.emit(threadId, { type: "event", event });
    return event;
  }

  private emit(threadId: string, event: LiveEvent): void {
    for (const listener of this.subscribers.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the turn
      }
    }
  }
}
