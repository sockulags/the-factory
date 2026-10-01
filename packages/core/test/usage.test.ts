import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DbHandle, openDb } from "@factory/db";
import { LocalRunner } from "@factory/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Board } from "../src/board.js";
import { ThreadService } from "../src/thread-service.js";
import { usageReport } from "../src/usage.js";
import { fakeAgent, gitRepo } from "./helpers.js";

describe("usageReport", () => {
  let handle: DbHandle;
  let runner: LocalRunner;

  beforeAll(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    const state = await mkdtemp(path.join(tmpdir(), "fake-"));
    runner = new LocalRunner([
      fakeAgent("alpha", state, { FAKE_USAGE: "1" }),
      fakeAgent("beta", state),
    ]);
  });
  afterAll(async () => {
    await runner.shutdown();
    await handle.close();
  });

  it("sums turns, tokens, cost and time per agent, card and day, scoped by product", async () => {
    const board = new Board(handle.db);
    const threads = new ThreadService({ db: handle.db, runner, turnTimeoutMs: 20_000 });
    const a = await board.createProduct({ key: "AAA", name: "A" });
    const b = await board.createProduct({ key: "BBB", name: "B" });
    const cardA = await board.createCard({ productId: a.id, type: "bug", title: "Card A" });
    const cardB = await board.createCard({ productId: b.id, type: "bug", title: "Card B" });
    const cwd = await gitRepo();
    const tA = await threads.createThread({ title: "a", cwd, cardId: cardA.id, step: "fix" });
    const tB = await threads.createThread({ title: "b", cwd, cardId: cardB.id, step: "fix" });
    await threads.send({ threadId: tA.id, agentId: "alpha", text: "Say: one" });
    await threads.send({ threadId: tA.id, agentId: "alpha", text: "Say: two" });
    await threads.send({ threadId: tA.id, agentId: "beta", text: "Say: three" });
    await threads.send({ threadId: tB.id, agentId: "alpha", text: "Say: four" });

    const all = await usageReport(handle.db, { days: 7 });
    expect(all.total).toMatchObject({ turns: 4, inputTokens: 300, outputTokens: 60 });
    expect(all.total.cost).toBeCloseTo(0.03);
    expect(all.byAgent.map((r) => [r.agentId, r.turns])).toEqual([
      ["alpha", 3],
      ["beta", 1],
    ]);
    expect(all.byDay).toHaveLength(1);

    const onlyA = await usageReport(handle.db, { productId: a.id, days: 7 });
    expect(onlyA.total.turns).toBe(3);
    expect(onlyA.byCard).toEqual([
      expect.objectContaining({ key: "AAA-1", title: "Card A", turns: 3, outputTokens: 40 }),
    ]);
  }, 60_000);
});
