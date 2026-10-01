import type { Card, CardEvent, HandoverRow, Thread, ThreadEvent } from "@factory/core";
import { PluginError, usageReport, WorkflowError } from "@factory/core";
import type {
  CardDetailDto,
  CardDto,
  CardEventDto,
  DocProposalDto,
  GateDecision,
  HandoverDto,
  ProductDto,
  RepoDto,
  ThreadDetailDto,
  ThreadEventDto,
  ThreadStreamEvent,
  ThreadSummaryDto,
  WorkflowDto,
} from "@factory/protocol";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { FactoryServices } from "./services.js";

export type ApiEnv = { Variables: { userId: string; roles: string[] } };

const iso = (d: Date) => d.toISOString();

export function factoryRoutes(f: FactoryServices, opts: { adminRole: string }) {
  const api = new Hono<ApiEnv>();
  /** Products, repos and integrations are managed by admins; everyone works cards. */
  const adminOnly = createMiddleware<ApiEnv>(async (c, next) => {
    if (!c.get("roles").includes(opts.adminRole)) {
      return c.json(
        { error: "forbidden", detail: `Only people with the "${opts.adminRole}" role can do this` },
        403,
      );
    }
    await next();
  });
  const actor = (userId: string) => `user:${userId}`;

  const cardDto = (c: Card): CardDto => ({
    id: c.id,
    key: c.key,
    productId: c.productId,
    repoId: c.repoId,
    number: c.number,
    type: c.type,
    title: c.title,
    body: c.body,
    step: c.step,
    state: c.state as CardDto["state"],
    rank: c.rank,
    assigneeId: c.assigneeId,
    branch: c.branch,
    worktreePath: c.worktreePath,
    busy: f.engine.isBusy(c.id),
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  });
  const eventDto = (e: CardEvent): CardEventDto => ({
    id: e.id,
    kind: e.kind,
    actor: e.actor,
    payload: e.payload as Record<string, unknown>,
    createdAt: iso(e.createdAt),
  });
  const handoverDto = (h: HandoverRow): HandoverDto => ({
    id: h.id,
    step: h.step,
    threadId: h.threadId,
    content: h.content,
    createdAt: iso(h.createdAt),
  });
  const threadSummary = (t: Thread): ThreadSummaryDto => ({
    id: t.id,
    title: t.title,
    step: t.step,
    driverAgentId: t.driverAgentId,
    createdAt: iso(t.createdAt),
  });
  const threadEventDto = (e: ThreadEvent): ThreadEventDto =>
    ({
      id: e.id,
      seq: e.seq,
      actor: e.actor,
      kind: e.kind,
      payload: e.payload,
      createdAt: iso(e.createdAt),
    }) as ThreadEventDto;

  const requireCard = async (id: string) => {
    const card = await f.board.getCard(id);
    if (!card) throw new NotFound("card");
    return card;
  };

  api.onError((err, c) => {
    if (err instanceof NotFound)
      return c.json({ error: "not_found", detail: `${err.message} not found` }, 404);
    if (err instanceof WorkflowError || err instanceof BadRequest || err instanceof PluginError) {
      return c.json({ error: "bad_request", detail: err.message }, 400);
    }
    if (err instanceof z.ZodError) {
      return c.json(
        {
          error: "bad_request",
          detail: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        400,
      );
    }
    console.error(err);
    return c.json({ error: "internal", detail: (err as Error).message }, 500);
  });

  // ── Reference data ─────────────────────────────────────────────
  api.get("/agents", (c) => c.json(f.agents.map((a) => ({ id: a.id, name: a.name }))));

  api.get("/workflows", (c) =>
    c.json(
      [...f.workflows.values()].map(
        (wf): WorkflowDto => ({
          type: wf.type,
          name: wf.name,
          description: wf.description,
          steps: wf.steps.map((s) => ({
            id: s.id,
            name: s.name,
            agent: s.agent,
            mode: s.mode as "write" | "consult",
            gate: s.gate,
            consult: s.consult,
          })),
        }),
      ),
    ),
  );

  // ── Products & repos ───────────────────────────────────────────
  api.get("/products", async (c) => c.json((await f.board.listProducts()).map(productDto)));

  api.post("/products", adminOnly, async (c) => {
    const body = z.object({ key: z.string(), name: z.string().min(1) }).parse(await c.req.json());
    try {
      return c.json(productDto(await f.board.createProduct(body)), 201);
    } catch (err) {
      throw new BadRequest(
        (err as Error).message.includes("unique")
          ? `product key ${body.key} is taken`
          : (err as Error).message,
      );
    }
  });

  api.get("/products/:id/repos", async (c) =>
    c.json((await f.board.listRepos(c.req.param("id"))).map(repoDto)),
  );

  api.post("/products/:id/repos", adminOnly, async (c) => {
    const body = z
      .object({
        name: z.string().min(1),
        path: z.string().min(1),
        defaultBranch: z.string().trim().optional(),
        checks: z.array(z.string().min(1)).default([]),
        setup: z.array(z.string().min(1)).default([]),
      })
      .parse(await c.req.json());
    if (!(await f.board.getProduct(c.req.param("id")))) throw new NotFound("product");
    // Catch a wrong path now rather than when the first card starts.
    const found = await f.runner.inspectRepo(body.path).catch((err: Error) => {
      throw new BadRequest(err.message);
    });
    const repo = await f.board.addRepo({
      productId: c.req.param("id"),
      ...body,
      path: found.path,
      defaultBranch: body.defaultBranch || found.defaultBranch,
    });
    return c.json(repoDto(repo), 201);
  });

  api.patch("/products/:id/repos/:repoId", adminOnly, async (c) => {
    const body = z
      .object({
        name: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        defaultBranch: z.string().trim().min(1).optional(),
        checks: z.array(z.string().min(1)).optional(),
        setup: z.array(z.string().min(1)).optional(),
      })
      .parse(await c.req.json());
    const existing = await f.board.getRepo(c.req.param("repoId"));
    if (!existing || existing.productId !== c.req.param("id")) throw new NotFound("repo");
    if (body.path) {
      body.path = (
        await f.runner.inspectRepo(body.path).catch((err: Error) => {
          throw new BadRequest(err.message);
        })
      ).path;
    }
    return c.json(repoDto(await f.board.updateRepo(existing.id, body)));
  });

  // ── Plugins ────────────────────────────────────────────────────
  api.get("/plugins", (c) =>
    c.json(
      f.plugins.list().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        exampleConfig: p.exampleConfig,
      })),
    ),
  );
  api.get("/products/:id/plugins", async (c) => c.json(await f.plugins.configs(c.req.param("id"))));
  api.put("/products/:id/plugins/:plugin", adminOnly, async (c) => {
    const body = z
      .object({ enabled: z.boolean(), config: z.record(z.string(), z.unknown()).default({}) })
      .parse(await c.req.json());
    if (!(await f.board.getProduct(c.req.param("id")))) throw new NotFound("product");
    return c.json(await f.plugins.configure(c.req.param("id"), c.req.param("plugin"), body));
  });

  // ── Usage ──────────────────────────────────────────────────────
  api.get("/usage", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
    return c.json(await usageReport(f.db, { productId: c.req.query("productId") || null, days }));
  });

  // ── Cards ──────────────────────────────────────────────────────
  api.get("/products/:id/cards", async (c) =>
    c.json((await f.board.listCards(c.req.param("id"))).map(cardDto)),
  );

  api.post("/products/:id/cards", async (c) => {
    const body = z
      .object({
        type: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().max(20_000).default(""),
        repoId: z.string().uuid().nullable().optional(),
      })
      .parse(await c.req.json());
    const productId = c.req.param("id");
    if (!(await f.board.getProduct(productId))) throw new NotFound("product");
    if (!f.workflows.has(body.type)) throw new BadRequest(`unknown card type "${body.type}"`);
    const repoId = body.repoId ?? (await f.board.listRepos(productId))[0]?.id ?? null;
    const card = await f.board.createCard({
      productId,
      repoId,
      type: body.type,
      title: body.title,
      body: body.body,
      createdBy: c.get("userId"),
    });
    f.bus.cardChanged(card.id);
    return c.json(cardDto(card), 201);
  });

  api.get("/cards/:id", async (c) => {
    const card = await requireCard(c.req.param("id"));
    const detail: CardDetailDto = {
      card: cardDto(card),
      events: (await f.board.events(card.id)).map(eventDto),
      handovers: (await f.board.handovers(card.id)).map(handoverDto),
      threads: (await f.board.cardThreads(card.id)).map(threadSummary),
      docProposals: (await f.board.docProposals(card.id)).map((p) => ({
        id: p.id,
        step: p.step,
        status: p.status as DocProposalDto["status"],
        patch: p.patch,
        files: p.files,
        outsideDocs: p.outsideDocs,
        reviewedBy: p.reviewedBy,
        createdAt: iso(p.createdAt),
      })),
      links: (await f.board.links(card.id)).map((l) => ({
        id: l.id,
        plugin: l.plugin,
        kind: l.kind,
        ref: l.ref,
        url: l.url,
        title: l.title,
      })),
    };
    return c.json(detail);
  });

  api.patch("/cards/:id", async (c) => {
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(20_000).optional(),
        rank: z.string().min(1).max(64).optional(),
        assigneeId: z.string().uuid().nullable().optional(),
      })
      .parse(await c.req.json());
    await requireCard(c.req.param("id"));
    const card = await f.board.updateCard(c.req.param("id"), body);
    f.bus.cardChanged(card.id);
    return c.json(cardDto(card));
  });

  // Workflow actions return 202 immediately; progress arrives on the streams.
  api.post("/cards/:id/start", async (c) => {
    await f.engine.start((await requireCard(c.req.param("id"))).id, actor(c.get("userId")));
    return c.json({ ok: true }, 202);
  });
  api.post("/cards/:id/decide", async (c) => {
    const body = z
      .object({
        decision: z.enum(["approved", "changes_requested"]),
        comment: z.string().max(20_000).optional(),
        /** With "approved" on a docs step: revert the proposed doc changes instead of committing them. */
        discardDocs: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const card = await requireCard(c.req.param("id"));
    await f.engine.decide(card.id, body.decision as GateDecision, {
      comment: body.comment,
      actor: actor(c.get("userId")),
      discardDocs: body.discardDocs,
    });
    return c.json({ ok: true }, 202);
  });
  api.post("/cards/:id/retry", async (c) => {
    await f.engine.retry((await requireCard(c.req.param("id"))).id, actor(c.get("userId")));
    return c.json({ ok: true }, 202);
  });
  api.post("/cards/:id/move", async (c) => {
    const body = z.object({ step: z.string() }).parse(await c.req.json());
    await f.engine.move(
      (await requireCard(c.req.param("id"))).id,
      body.step,
      actor(c.get("userId")),
    );
    return c.json({ ok: true }, 202);
  });
  api.post("/cards/:id/close", async (c) => {
    await f.engine.close((await requireCard(c.req.param("id"))).id, actor(c.get("userId")));
    return c.json({ ok: true }, 202);
  });

  /** Ad-hoc thread on a card (e.g. a question outside the workflow), in the card's worktree. */
  api.post("/cards/:id/threads", async (c) => {
    const body = z.object({ title: z.string().min(1).max(200) }).parse(await c.req.json());
    const card = await requireCard(c.req.param("id"));
    if (!card.worktreePath)
      throw new BadRequest(`${card.key} has no worktree yet; start the card first`);
    const thread = await f.threads.createThread({
      title: body.title,
      cwd: card.worktreePath,
      cardId: card.id,
      createdBy: c.get("userId"),
    });
    f.bus.cardChanged(card.id);
    return c.json(threadSummary(thread), 201);
  });

  // ── Threads ────────────────────────────────────────────────────
  api.get("/threads/:id", async (c) => {
    const thread = await f.threads.getThread(c.req.param("id"));
    if (!thread) throw new NotFound("thread");
    const events = await f.threads.events(thread.id);
    const names = Object.fromEntries(
      Object.entries(await f.threads.userNames(events)).map(([id, name]) => [`user:${id}`, name]),
    );
    const detail: ThreadDetailDto = {
      thread: { ...threadSummary(thread), cardId: thread.cardId, cwd: thread.cwd },
      events: events.map(threadEventDto),
      running: f.threads.isRunning(thread.id),
      names,
    };
    return c.json(detail);
  });

  /** Post a message to an agent: the model switch. Returns at once; the turn streams. */
  api.post("/threads/:id/messages", async (c) => {
    const body = z
      .object({
        agentId: z.string(),
        text: z.string().min(1).max(100_000),
        mode: z.enum(["write", "consult"]).default("write"),
      })
      .parse(await c.req.json());
    const thread = await f.threads.getThread(c.req.param("id"));
    if (!thread) throw new NotFound("thread");
    if (!f.agents.some((a) => a.id === body.agentId))
      throw new BadRequest(`unknown agent "${body.agentId}"`);
    if (thread.cardId && f.engine.isBusy(thread.cardId) && body.mode === "write") {
      throw new BadRequest(
        "the workflow is running on this card; consult instead, or wait for the gate",
      );
    }
    void f.threads
      .send({
        threadId: thread.id,
        agentId: body.agentId,
        text: body.text,
        mode: body.mode,
        userId: c.get("userId"),
      })
      .catch(() => undefined); // recorded as an error event in the thread
    return c.json({ ok: true }, 202);
  });

  api.post("/threads/:id/cancel", async (c) => {
    await f.threads.cancel(c.req.param("id"));
    return c.json({ ok: true });
  });

  api.get("/threads/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      const threadId = c.req.param("id");
      const queue: ThreadStreamEvent[] = [];
      let wake: (() => void) | null = null;
      const push = (e: ThreadStreamEvent) => {
        queue.push(e);
        wake?.();
      };
      const unsubscribe = f.threads.subscribe(threadId, (e) => {
        if (e.type === "event") push({ type: "event", event: threadEventDto(e.event) });
        else if (e.type === "turn") push({ type: "turn", state: e.state, agentId: e.agentId });
        else if (
          e.update.sessionUpdate === "agent_message_chunk" &&
          e.update.content.type === "text"
        ) {
          push({ type: "chunk", agentId: e.agentId, text: e.update.content.text });
        } else if (e.update.sessionUpdate === "tool_call") {
          push({
            type: "tool",
            agentId: e.agentId,
            title: e.update.title,
            kind: e.update.kind ?? null,
            status: e.update.status ?? null,
          });
        }
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await pump(stream, queue, (w) => {
        wake = w;
      });
      unsubscribe();
    }),
  );

  /** Board-wide change notifications. */
  api.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: { type: "card"; cardId: string; productId: string }[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = f.bus.on((cardId) => {
        void f.board.getCard(cardId).then((card) => {
          if (!card) return;
          queue.push({ type: "card", cardId, productId: card.productId });
          wake?.();
        });
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ data: JSON.stringify({ type: "hello" }) });
      await pump(stream, queue, (w) => {
        wake = w;
      });
      unsubscribe();
    }),
  );

  return api;
}

/** Writes queued events until the client disconnects; pings every 20s to keep proxies open. */
async function pump<T>(
  stream: { aborted: boolean; writeSSE(m: { data: string; event?: string }): Promise<void> },
  queue: T[],
  setWake: (wake: (() => void) | null) => void,
) {
  while (!stream.aborted) {
    while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      setWake(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    setWake(null);
    if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
  }
}

const productDto = (p: { id: string; key: string; name: string }): ProductDto => ({
  id: p.id,
  key: p.key,
  name: p.name,
});
const repoDto = (r: RepoDto): RepoDto => ({
  id: r.id,
  productId: r.productId,
  name: r.name,
  path: r.path,
  defaultBranch: r.defaultBranch,
  checks: r.checks,
  setup: r.setup,
});

class NotFound extends Error {}
class BadRequest extends Error {}
