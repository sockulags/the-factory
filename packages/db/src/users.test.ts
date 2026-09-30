import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DbHandle, openDb } from "./client.js";
import { upsertUserFromIdentity } from "./users.js";

describe("upsertUserFromIdentity", () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
  });
  afterEach(() => handle.close());

  it("creates a user on first sign-in and updates it later", async () => {
    const first = await upsertUserFromIdentity(handle.db, {
      subject: "sub-1",
      username: "ada",
      name: "Ada",
      email: null,
    });
    const second = await upsertUserFromIdentity(handle.db, {
      subject: "sub-1",
      username: "ada",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Ada Lovelace");
    expect(second.email).toBe("ada@example.com");
  });
});
