import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  /**
   * `postgres://…` for a real server, `pglite:<dir>` for embedded Postgres on disk,
   * or `pglite:memory` for an in-memory database (tests).
   */
  url: string;
  /** Folder containing drizzle migrations. Defaults to the package's `drizzle/` folder. */
  migrationsFolder?: string;
}

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function openDb({
  url,
  migrationsFolder = defaultMigrationsFolder,
}: OpenDbOptions): Promise<DbHandle> {
  if (url.startsWith("pglite:")) {
    const location = url.slice("pglite:".length);
    const client = location === "memory" ? new PGlite() : new PGlite(location);
    const db = drizzlePglite(client, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migratePglite(db, { migrationsFolder }),
      close: () => client.close(),
    };
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migratePg(db, { migrationsFolder }),
      close: () => pool.end(),
    };
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split(":")[0]}`);
}
