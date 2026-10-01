import { type Db, schema } from "@factory/db";
import { and, asc, desc, eq, max } from "drizzle-orm";
import { type HandoverContent, handoverToMarkdown } from "./workflow/handover.js";

const { products, repos, cards, cardEvents, handovers, threads, docProposals, externalLinks } =
  schema;

export type Product = typeof products.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type Card = CardRow & { key: string };
export type CardEvent = typeof cardEvents.$inferSelect;
export type DocProposal = typeof docProposals.$inferSelect;
export type ExternalLink = typeof externalLinks.$inferSelect;
export type HandoverRow = Omit<typeof handovers.$inferSelect, "content"> & {
  content: HandoverContent;
};

export type CardState = "backlog" | "running" | "awaiting_gate" | "blocked" | "done" | "closed";

/** Persistence for products, repos, cards, card history and handovers. */
export class Board {
  constructor(private readonly db: Db) {}

  async createProduct(input: { key: string; name: string }): Promise<Product> {
    const key = input.key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key))
      throw new Error("product key must be 2–10 letters/digits, e.g. WEB");
    const [row] = await this.db
      .insert(products)
      .values({ key, name: input.name.trim() })
      .returning();
    if (!row) throw new Error("failed to create product");
    return row;
  }

  listProducts(): Promise<Product[]> {
    return this.db.select().from(products).orderBy(asc(products.name));
  }

  async getProduct(id: string): Promise<Product | null> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id));
    return row ?? null;
  }

  async addRepo(input: {
    productId: string;
    name: string;
    path: string;
    defaultBranch?: string;
    checks?: string[];
    setup?: string[];
  }): Promise<Repo> {
    const [row] = await this.db
      .insert(repos)
      .values({
        productId: input.productId,
        name: input.name,
        path: input.path,
        defaultBranch: input.defaultBranch ?? "main",
        checks: input.checks ?? [],
        setup: input.setup ?? [],
      })
      .returning();
    if (!row) throw new Error("failed to add repo");
    return row;
  }

  async updateRepo(
    id: string,
    patch: Partial<Pick<Repo, "name" | "path" | "defaultBranch" | "checks" | "setup">>,
  ): Promise<Repo> {
    const [row] = await this.db.update(repos).set(patch).where(eq(repos.id, id)).returning();
    if (!row) throw new Error(`unknown repo ${id}`);
    return row;
  }

  listRepos(productId: string): Promise<Repo[]> {
    return this.db.select().from(repos).where(eq(repos.productId, productId));
  }

  async getRepo(id: string): Promise<Repo | null> {
    const [row] = await this.db.select().from(repos).where(eq(repos.id, id));
    return row ?? null;
  }

  async createCard(input: {
    productId: string;
    repoId?: string | null;
    type: string;
    title: string;
    body?: string;
    createdBy?: string | null;
  }): Promise<Card> {
    const [current] = await this.db
      .select({ n: max(cards.number) })
      .from(cards)
      .where(eq(cards.productId, input.productId));
    const [row] = await this.db
      .insert(cards)
      .values({
        productId: input.productId,
        repoId: input.repoId ?? null,
        number: (current?.n ?? 0) + 1,
        type: input.type,
        title: input.title.trim(),
        body: input.body ?? "",
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to create card");
    const card = await this.withKey(row);
    await this.addEvent(
      card.id,
      "created",
      input.createdBy ? `user:${input.createdBy}` : "system",
      {
        type: input.type,
        title: card.title,
      },
    );
    return card;
  }

  async getCard(id: string): Promise<Card | null> {
    const [row] = await this.db.select().from(cards).where(eq(cards.id, id));
    return row ? this.withKey(row) : null;
  }

  /** Looks a card up by its key, e.g. "WEB-12". */
  async findCardByKey(key: string): Promise<Card | null> {
    const match = key
      .trim()
      .toUpperCase()
      .match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
    if (!match) return null;
    const [product] = await this.db
      .select()
      .from(products)
      .where(eq(products.key, match[1] ?? ""));
    if (!product) return null;
    const [row] = await this.db
      .select()
      .from(cards)
      .where(and(eq(cards.productId, product.id), eq(cards.number, Number(match[2]))));
    return row ? { ...row, key: `${product.key}-${row.number}` } : null;
  }

  async findProductByKey(key: string): Promise<Product | null> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(eq(products.key, key.trim().toUpperCase()));
    return row ?? null;
  }

  async listCards(productId: string): Promise<Card[]> {
    const product = await this.getProduct(productId);
    const rows = await this.db
      .select()
      .from(cards)
      .where(eq(cards.productId, productId))
      .orderBy(asc(cards.rank), asc(cards.number));
    return rows.map((r) => ({ ...r, key: `${product?.key ?? "?"}-${r.number}` }));
  }

  /** Cards in `state` across all products (e.g. the ones a restart left "running"). */
  async cardsInState(state: string): Promise<Card[]> {
    const rows = await this.db.select().from(cards).where(eq(cards.state, state));
    return Promise.all(rows.map((r) => this.withKey(r)));
  }

  async updateCard(
    id: string,
    patch: Partial<
      Pick<
        CardRow,
        | "title"
        | "body"
        | "step"
        | "state"
        | "rank"
        | "assigneeId"
        | "branch"
        | "worktreePath"
        | "repoId"
      >
    >,
  ): Promise<Card> {
    const [row] = await this.db
      .update(cards)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    if (!row) throw new Error(`unknown card ${id}`);
    return this.withKey(row);
  }

  async addEvent(
    cardId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<CardEvent> {
    const [row] = await this.db
      .insert(cardEvents)
      .values({ cardId, kind, actor, payload })
      .returning();
    if (!row) throw new Error("failed to add card event");
    return row;
  }

  events(cardId: string): Promise<CardEvent[]> {
    return this.db
      .select()
      .from(cardEvents)
      .where(eq(cardEvents.cardId, cardId))
      .orderBy(asc(cardEvents.createdAt));
  }

  async saveHandover(input: {
    cardId: string;
    step: string;
    threadId: string | null;
    content: HandoverContent;
  }) {
    const [row] = await this.db.insert(handovers).values(input).returning();
    if (!row) throw new Error("failed to save handover");
    return row as HandoverRow;
  }

  async handovers(cardId: string): Promise<HandoverRow[]> {
    const rows = await this.db
      .select()
      .from(handovers)
      .where(eq(handovers.cardId, cardId))
      .orderBy(asc(handovers.createdAt));
    return rows as HandoverRow[];
  }

  /** The newest handover, optionally only from other steps (i.e. the previous step's). */
  async latestHandover(
    cardId: string,
    opts: { excludeStep?: string; step?: string } = {},
  ): Promise<HandoverRow | null> {
    const rows = await this.db
      .select()
      .from(handovers)
      .where(eq(handovers.cardId, cardId))
      .orderBy(desc(handovers.createdAt));
    const match = rows.find(
      (r) =>
        (!opts.excludeStep || r.step !== opts.excludeStep) && (!opts.step || r.step === opts.step),
    );
    return (match as HandoverRow | undefined) ?? null;
  }

  async stepThread(cardId: string, step: string) {
    const [row] = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.cardId, cardId), eq(threads.step, step)));
    return row ?? null;
  }

  cardThreads(cardId: string) {
    return this.db
      .select()
      .from(threads)
      .where(eq(threads.cardId, cardId))
      .orderBy(asc(threads.createdAt));
  }

  /** For ThreadService.handoverFor: the latest handover of the thread's card, as markdown. */
  async handoverForThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, threadId));
    if (!thread?.cardId) return null;
    const latest = await this.latestHandover(thread.cardId);
    return latest ? handoverToMarkdown(latest.content, `Handover from ${latest.step}`) : null;
  }

  async saveDocProposal(
    input: Omit<
      typeof docProposals.$inferInsert,
      "id" | "status" | "createdAt" | "reviewedBy" | "reviewedAt"
    >,
  ): Promise<DocProposal> {
    // A new proposal for the step replaces any still-pending one.
    await this.db
      .update(docProposals)
      .set({ status: "superseded" })
      .where(
        and(
          eq(docProposals.cardId, input.cardId),
          eq(docProposals.step, input.step),
          eq(docProposals.status, "pending"),
        ),
      );
    const [row] = await this.db.insert(docProposals).values(input).returning();
    if (!row) throw new Error("failed to save doc proposal");
    return row;
  }

  async pendingDocProposal(cardId: string, step: string): Promise<DocProposal | null> {
    const [row] = await this.db
      .select()
      .from(docProposals)
      .where(
        and(
          eq(docProposals.cardId, cardId),
          eq(docProposals.step, step),
          eq(docProposals.status, "pending"),
        ),
      )
      .orderBy(desc(docProposals.createdAt));
    return row ?? null;
  }

  async reviewDocProposal(
    id: string,
    status: "approved" | "discarded",
    reviewedBy: string,
  ): Promise<void> {
    await this.db
      .update(docProposals)
      .set({ status, reviewedBy, reviewedAt: new Date() })
      .where(eq(docProposals.id, id));
  }

  docProposals(cardId: string): Promise<DocProposal[]> {
    return this.db
      .select()
      .from(docProposals)
      .where(eq(docProposals.cardId, cardId))
      .orderBy(asc(docProposals.createdAt));
  }

  /** Links a card to something in another system; idempotent per (plugin, kind, ref). */
  async addLink(input: {
    cardId: string;
    plugin: string;
    kind: string;
    ref: string;
    url: string;
    title?: string | null;
  }) {
    const existing = (await this.links(input.cardId)).find(
      (l) => l.plugin === input.plugin && l.kind === input.kind && l.ref === input.ref,
    );
    if (existing) return existing;
    const [row] = await this.db
      .insert(externalLinks)
      .values({ ...input, title: input.title ?? null })
      .returning();
    if (!row) throw new Error("failed to add link");
    return row;
  }

  links(cardId: string): Promise<ExternalLink[]> {
    return this.db
      .select()
      .from(externalLinks)
      .where(eq(externalLinks.cardId, cardId))
      .orderBy(asc(externalLinks.createdAt));
  }

  private async withKey(row: CardRow): Promise<Card> {
    const product = await this.getProduct(row.productId);
    return { ...row, key: `${product?.key ?? "?"}-${row.number}` };
  }
}
