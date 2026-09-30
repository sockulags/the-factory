import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** People who have signed in. Identity comes from the IdP; this row is our local record of them. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** OIDC `sub` claim — stable id from the identity provider. */
  subject: text("subject").notNull().unique(),
  username: text("username").notNull(),
  name: text("name"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A conversation with one or more agents about one piece of work. Workflow steps each own
 * a thread (phase 3); ad-hoc threads are allowed too. `cwd` is the worktree the agents share.
 */
export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  cwd: text("cwd").notNull(),
  /** Card and workflow step this thread belongs to; null for ad-hoc threads. */
  cardId: uuid("card_id").references(() => cards.id, { onDelete: "cascade" }),
  step: text("step"),
  createdBy: uuid("created_by").references(() => users.id),
  /** Agent currently allowed to write in the worktree (the "driver"). */
  driverAgentId: text("driver_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only canonical log of a thread. We own this; providers keep their own
 * sessions and are synced from it via per-agent cursors (agent_sessions.cursor_seq).
 */
export const threadEvents = pgTable(
  "thread_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    /** "user:<id>", "agent:<id>" or "system". */
    actor: text("actor").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("thread_events_thread_seq").on(t.threadId, t.seq)],
);

/** The provider-side session each agent keeps for a thread, and how far it has read. */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    acpSessionId: text("acp_session_id").notNull(),
    /** Last thread event this agent has seen. */
    cursorSeq: integer("cursor_seq").notNull(),
    /** Worktree snapshot taken at the end of this agent's last turn. */
    lastCheckpoint: text("last_checkpoint"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.agentId] })],
);

/** A product the team works on. Owns repos and cards. */
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Short uppercase prefix for card keys, e.g. "WEB" → WEB-42. */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A git repository of a product, as checked out on the runner. */
export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Path of the main checkout on the runner; card worktrees are created from it. */
  path: text("path").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  /** Commands the `checks` gate runs in the worktree, e.g. ["pnpm test"]. */
  checks: jsonb("checks").$type<string[]>().notNull().default([]),
});

/**
 * A unit of work on the board. `type` selects the workflow; `step` is the workflow step
 * it is in (null while in the backlog); `state` says what the step is doing.
 */
export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").references(() => repos.id),
    number: integer("number").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    step: text("step"),
    /** backlog | running | awaiting_gate | blocked | done | closed */
    state: text("state").notNull().default("backlog"),
    rank: text("rank").notNull().default("m"),
    assigneeId: uuid("assignee_id").references(() => users.id),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cards_product_number").on(t.productId, t.number)],
);

/** Card history: step transitions, gate decisions, hooks, errors. Feeds the activity view. */
export const cardEvents = pgTable("card_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  actor: text("actor").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Structured summary written at the end of each step; the next step starts from it. */
export const handovers = pgTable("handovers", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  step: text("step").notNull(),
  threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
