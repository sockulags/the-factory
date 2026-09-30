import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { users } from "./schema.js";

export interface IdentityClaims {
  subject: string;
  username: string;
  name: string | null;
  email: string | null;
}

export type User = typeof users.$inferSelect;

/** Creates the user on first sign-in, refreshes profile fields and last-seen on later ones. */
export async function upsertUserFromIdentity(db: Db, claims: IdentityClaims): Promise<User> {
  const [row] = await db
    .insert(users)
    .values(claims)
    .onConflictDoUpdate({
      target: users.subject,
      set: {
        username: claims.username,
        name: claims.name,
        email: claims.email,
        lastSeenAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return row;
}
