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
