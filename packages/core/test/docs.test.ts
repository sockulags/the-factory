import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DbHandle, openDb } from "@factory/db";
import { LocalRunner } from "@factory/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Board, type Card } from "../src/board.js";
import { docsIndex, relevantDocs } from "../src/docs-context.js";
import { ThreadService } from "../src/thread-service.js";
import { loadWorkflows } from "../src/workflow/definition.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { fakeAgent, git, gitRepo } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("docs step", () => {
  let handle: DbHandle;
  let runner: LocalRunner;
  let board: Board;
  let engine: WorkflowEngine;
  let productId: string;
  let repoId: string;

  beforeAll(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    runner = new LocalRunner([
      fakeAgent("alpha", await mkdtemp(path.join(tmpdir(), "fake-")), { FAKE_LOAD: "1" }),
    ]);
    board = new Board(handle.db);
    const threads = new ThreadService({ db: handle.db, runner, turnTimeoutMs: 20_000 });
    engine = new WorkflowEngine({
      board,
      threads,
      runner,
      workflows: await loadWorkflows(path.join(here, "fixtures/workflows"), ["alpha", "beta"]),
      worktreesDir: await mkdtemp(path.join(tmpdir(), "wt-")),
    });
    const repoPath = await gitRepo();
    productId = (await board.createProduct({ key: "DOC", name: "Docs" })).id;
    repoId = (
      await board.addRepo({
        productId,
        name: "r",
        path: repoPath,
        defaultBranch: await git(repoPath, "branch", "--show-current"),
      })
    ).id;
  });
  afterAll(async () => {
    await runner.shutdown();
    await handle.close();
  });

  const run = async (title: string) => {
    const card = await board.createCard({ productId, repoId, type: "docs-lite", title });
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    return (await board.getCard(card.id)) as Card;
  };

  it("proposes the docs diff, commits code per step and docs on approval", async () => {
    const card = await run("Export to CSV");
    expect(card).toMatchObject({ step: "docs", state: "awaiting_gate" });
    const wt = card.worktreePath as string;

    // The write step was approved automatically and committed.
    expect(await git(wt, "log", "--format=%s", "-1")).toMatch(/^DOC-1 Write: /);
    expect(await git(wt, "show", "--name-only", "--format=", "HEAD")).toBe("src/feature.txt");

    const proposal = await board.pendingDocProposal(card.id, "docs");
    expect(proposal?.files).toEqual([{ path: "docs/guide.md", added: 1, removed: 0 }]);
    expect(proposal?.outsideDocs).toEqual([]);
    expect(proposal?.patch).toContain("+# Guide for Export to CSV");

    // Request changes: the step re-runs in the same thread; the new proposal keeps the base.
    await engine.decide(card.id, "changes_requested", { comment: "Mention the delimiter." });
    await engine.whenIdle(card.id);
    const again = await board.pendingDocProposal(card.id, "docs");
    expect(again?.id).not.toBe(proposal?.id);
    expect(again?.baseCheckpoint).toBe(proposal?.baseCheckpoint);
    expect((await board.docProposals(card.id)).map((p) => p.status)).toEqual([
      "superseded",
      "pending",
    ]);

    await engine.decide(card.id, "approved", { actor: "user:reviewer" });
    await engine.whenIdle(card.id);
    expect((await board.getCard(card.id))?.state).toBe("done");
    expect((await board.docProposals(card.id)).at(-1)).toMatchObject({
      status: "approved",
      reviewedBy: "user:reviewer",
    });
    expect(await git(wt, "show", "--name-only", "--format=", "HEAD")).toBe("docs/guide.md");
    expect(await git(wt, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("discarding reverts the doc changes and commits nothing for them", async () => {
    const card = await run("Dark mode");
    const wt = card.worktreePath as string;
    expect(existsSync(path.join(wt, "docs/guide.md"))).toBe(true);
    const head = await git(wt, "rev-parse", "HEAD");

    await engine.decide(card.id, "approved", { discardDocs: true });
    await engine.whenIdle(card.id);
    expect(existsSync(path.join(wt, "docs/guide.md"))).toBe(false);
    expect(await git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(await git(wt, "status", "--porcelain")).toBe("");
    expect((await board.docProposals(card.id)).at(-1)?.status).toBe("discarded");
    expect(await readFile(path.join(wt, "src/feature.txt"), "utf8")).toBe("feature");
  }, 60_000);
});

describe("doc context", () => {
  const docs = [
    {
      path: "docs/billing.md",
      title: "Billing",
      content: "# Billing\n\nInvoices are generated monthly. Export invoices as CSV.",
    },
    {
      path: "docs/auth.md",
      title: "Sign-in",
      content: "# Sign-in\n\nWe use Keycloak for sign-in and sessions.",
    },
    {
      path: "docs/export.md",
      title: "Export",
      content: "# Export\n\nCSV export of reports. The delimiter is a comma.",
    },
  ];

  it("lists pages", () => {
    expect(docsIndex(docs)).toBe(
      "- `docs/billing.md` — Billing\n- `docs/auth.md` — Sign-in\n- `docs/export.md` — Export",
    );
  });

  it("ranks pages by overlap with the card, titles weighted", () => {
    const out = relevantDocs(docs, "CSV export uses the wrong delimiter");
    expect(out.startsWith("#### `docs/export.md`")).toBe(true);
    expect(out).not.toContain("docs/auth.md");
    // A passing mention isn't enough; a title match is.
    expect(relevantDocs(docs, "invoice totals are wrong in billing")).toContain("docs/billing.md");
  });

  it("returns nothing for unrelated cards and respects the budget", () => {
    expect(relevantDocs(docs, "the")).toBe("");
    const big = [
      { path: "docs/big.md", title: "Export", content: `# Export\n${"csv export ".repeat(2000)}` },
    ];
    expect(relevantDocs(big, "csv export", 1000).length).toBeLessThan(1200);
  });
});
