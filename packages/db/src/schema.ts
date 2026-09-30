import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
