import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DbHandle, openDb } from "@factory/db";
import { LocalRunner } from "@factory/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Board, type Card } from "../src/board.js";
import type { AgentMessagePayload } from "../src/events.js";
import { ThreadService } from "../src/thread-service.js";
import { loadWorkflows } from "../src/workflow/definition.js";
import { WorkflowEngine, WorkflowError } from "../src/workflow/engine.js";
import { fakeAgent, git, gitRepo } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("WorkflowEngine", () => {
  let handle: DbHandle;
  let runner: LocalRunner;
  let board: Board;
  let threads: ThreadService;
  let engine: WorkflowEngine;
  let repoPath: string;
  let productId: string;
  let repoId: string;
  const changes: string[] = [];
  const hookCalls: string[] = [];

  beforeAll(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    const stateDir = await mkdtemp(path.join(tmpdir(), "fake-state-"));
    runner = new LocalRunner([
      fakeAgent("alpha", stateDir, { FAKE_LOAD: "1", FAKE_ON_CHECKS_FAILED: "fixed.txt" }),
      fakeAgent("beta", stateDir),
    ]);
    board = new Board(handle.db);
    threads = new ThreadService({
      db: handle.db,
      runner,
      turnTimeoutMs: 20_000,
      handoverFor: (id) => board.handoverForThread(id),
    });
    engine = new WorkflowEngine({
      board,
      threads,
      runner,
      workflows: await loadWorkflows(path.join(here, "fixtures/workflows"), ["alpha", "beta"]),
      worktreesDir: await mkdtemp(path.join(tmpdir(), "worktrees-")),
      hooks: {
        "test.hook": async ({ card, step }) => {
          hookCalls.push(`${card.key}:${step.id}`);
          return { ok: true };
        },
      },
      onCardChange: (id) => changes.push(id),
    });
    repoPath = await gitRepo();
    const product = await board.createProduct({ key: "web", name: "Web app" });
    productId = product.id;
    const repo = await board.addRepo({
      productId,
      name: "web",
      path: repoPath,
      defaultBranch: await git(repoPath, "branch", "--show-current"),
      checks: ["test -f fixed.txt"],
    });
    repoId = repo.id;
  });

  afterAll(async () => {
    await runner.shutdown();
    await handle.close();
  });

  const reload = async (card: Card) => (await board.getCard(card.id)) as Card;

  it("runs a card through triage, a failing-then-passing checks gate, review, and back", async () => {
    let card = await board.createCard({
      productId,
      repoId,
      type: "lite",
      title: "Login button does nothing",
    });
    expect(card.key).toBe("WEB-1");
    expect(card.state).toBe("backlog");

    // Triage: human gate.
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    card = await reload(card);
    expect(card).toMatchObject({ step: "triage", state: "awaiting_gate" });
    expect(card.branch).toBe("factory/web-1-login-button-does-nothing");
    expect(existsSync(card.worktreePath as string)).toBe(true);

    const triageThread = await board.stepThread(card.id, "triage");
    const triageEvents = await threads.events(triageThread?.id as string);
    expect((triageEvents[1]?.payload as AgentMessagePayload).text).toBe(
      "triaged WEB-1 Login button does nothing",
    );
    expect((triageEvents[1]?.payload as AgentMessagePayload).mode).toBe("consult");
    const triageHandover = await board.latestHandover(card.id, { step: "triage" });
    expect(triageHandover?.content.format).toBe("structured");

    // Approve → fix. Checks fail once (no fixed.txt), the output goes back into the fix
    // thread, the agent fixes it, checks pass → review (human gate).
    await engine.decide(card.id, "approved", { comment: "Go", actor: "user:lucas" });
    await engine.whenIdle(card.id);
    card = await reload(card);
    expect(card).toMatchObject({ step: "review", state: "awaiting_gate" });
    expect(await readFile(path.join(card.worktreePath as string, "fixed.txt"), "utf8")).toBe(
      "ok\n",
    );

    const fixThread = await board.stepThread(card.id, "fix");
    const fixMessages = (await threads.events(fixThread?.id as string)).filter(
      (e) => e.kind === "user_message",
    );
    expect(fixMessages[0]?.payload).toMatchObject({ to: "alpha", mode: "write" });
    expect((fixMessages[0]?.payload as { text: string }).text).toContain(
      "Say: fixing on factory/web-1",
    );
    expect((fixMessages[0]?.payload as { text: string }).text).toContain("Handover from triage");
    expect(
      fixMessages.some((m) =>
        (m.payload as { text: string }).text.includes("The checks failed (attempt 1 of 2)"),
      ),
    ).toBe(true);

    // Review had a consult (alpha critiques beta), then beta revises.
    const reviewThread = await board.stepThread(card.id, "review");
    const reviewAgents = (await threads.events(reviewThread?.id as string))
      .filter((e) => e.kind === "agent_message")
      .map((e) => e.actor);
    expect(reviewAgents.slice(0, 3)).toEqual(["agent:beta", "agent:alpha", "agent:beta"]);

    // Changes requested → back to fix, continuing the same fix thread.
    await engine.decide(card.id, "changes_requested", { comment: "Also handle the Enter key." });
    await engine.whenIdle(card.id);
    card = await reload(card);
    expect(await board.stepThread(card.id, "fix")).toMatchObject({ id: fixThread?.id });
    const reentry = (await threads.events(fixThread?.id as string)).filter(
      (e) => e.kind === "user_message",
    );
    const feedback = reentry.find((m) =>
      (m.payload as { text: string }).text.includes("Also handle the Enter key."),
    );
    expect(feedback).toBeTruthy();
    expect((feedback?.payload as { text: string }).text).toContain("Handover from Review");
    expect(card).toMatchObject({ step: "review", state: "awaiting_gate" });

    // Approve review → done, running exit hooks (one provided, one missing).
    await engine.decide(card.id, "approved");
    await engine.whenIdle(card.id);
    card = await reload(card);
    expect(card.state).toBe("done");
    expect(hookCalls).toEqual(["WEB-1:review"]);
    const kinds = (await board.events(card.id)).map((e) => e.kind);
    expect(kinds).toContain("hook_ran");
    expect(kinds).toContain("hook_skipped");
    expect(kinds.filter((k) => k === "checks_failed")).toHaveLength(1);
    expect(changes).toContain(card.id);

    // Close → worktree and snapshot refs removed, branch kept.
    const worktree = card.worktreePath as string;
    await engine.close(card.id);
    await engine.whenIdle(card.id);
    expect(existsSync(worktree)).toBe(false);
    expect(await git(repoPath, "for-each-ref", "refs/factory")).toBe("");
    expect(await git(repoPath, "branch", "--list", "factory/web-1-*")).toContain(
      "factory/web-1-login-button-does-nothing",
    );
    expect((await reload(card)).state).toBe("closed");
  }, 120_000);

  it("rejects invalid requests immediately", async () => {
    const card = await board.createCard({ productId, repoId, type: "lite", title: "Second" });
    await expect(engine.decide(card.id, "approved")).rejects.toBeInstanceOf(WorkflowError);
    await expect(engine.move(card.id, "nope")).rejects.toThrow(/no step "nope"/);
    const other = await board.createCard({ productId, type: "unknown-type", title: "x" });
    await expect(engine.start(other.id)).rejects.toThrow(/no workflow/);
  });

  it("blocks a card when a step fails and lets a person retry", async () => {
    const card = await board.createCard({ productId, repoId, type: "lite", title: "Will fail" });
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    // Break the runner for the next step: an unknown agent makes the turn throw.
    const wf = engine.workflow("lite");
    const fix = wf.steps.find((s) => s.id === "fix");
    if (!fix) throw new Error("fixture");
    const original = fix.agent;
    fix.agent = "ghost";
    await engine.decide(card.id, "approved");
    await engine.whenIdle(card.id);
    let current = await reload(card);
    expect(current).toMatchObject({ step: "fix", state: "blocked" });
    expect((await board.events(card.id)).at(-1)).toMatchObject({ kind: "error" });

    fix.agent = original;
    await engine.retry(card.id);
    await engine.whenIdle(card.id);
    current = await reload(card);
    expect(current.state).toBe("awaiting_gate");
    expect(current.step).toBe("review");
  }, 60_000);

  it("resumes a card a restart left running, but blocks it if that keeps happening", async () => {
    const card = await board.createCard({ productId, repoId, type: "lite", title: "Restarted" });
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    const thread = await board.stepThread(card.id, "triage");
    // Simulate a restart mid-step: the database still says "running", nothing is queued.
    await board.updateCard(card.id, { state: "running" });
    expect(await engine.recover()).toEqual([card.key]);
    await engine.whenIdle(card.id);
    let current = await reload(card);
    expect(current).toMatchObject({ step: "triage", state: "awaiting_gate" });
    expect(await board.stepThread(card.id, "triage")).toMatchObject({ id: thread?.id });
    const kinds = (await board.events(card.id)).map((e) => e.kind);
    expect(kinds.slice(kinds.indexOf("interrupted"))).toContain("step_started");

    // Interrupted again right after being resumed: block instead of looping.
    await board.addEvent(card.id, "interrupted", "system", { step: "triage", resumed: true });
    await board.addEvent(card.id, "step_started", "system", { step: "triage", reentry: true });
    await board.updateCard(card.id, { state: "running" });
    await engine.recover();
    await engine.whenIdle(card.id);
    current = await reload(card);
    expect(current.state).toBe("blocked");
    expect((await board.events(card.id)).at(-1)?.payload).toMatchObject({
      message: expect.stringContaining("Retry"),
    });
    expect(await engine.recover()).toEqual([]);
  }, 60_000);

  it("runs the repo's setup once per worktree; a failing setup blocks until retried", async () => {
    const repo = await board.addRepo({
      productId,
      name: "web-setup",
      path: repoPath,
      defaultBranch: await git(repoPath, "branch", "--show-current"),
      setup: ["exit 3"],
    });
    const card = await board.createCard({
      productId,
      repoId: repo.id,
      type: "lite",
      title: "Setup",
    });
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    expect(await reload(card)).toMatchObject({ step: "triage", state: "blocked" });
    expect((await board.events(card.id)).at(-1)?.payload).toMatchObject({
      message: expect.stringContaining("Worktree setup failed: exit 3"),
    });

    await board.updateRepo(repo.id, {
      setup: ["node -e \"require('fs').appendFileSync('setup.log','x')\""],
    });
    await engine.retry(card.id);
    await engine.whenIdle(card.id);
    const current = await reload(card);
    expect(current.state).toBe("awaiting_gate");
    await engine.decide(card.id, "approved");
    await engine.whenIdle(card.id);
    // Ran once, not again for the next step.
    expect(await readFile(path.join(current.worktreePath as string, "setup.log"), "utf8")).toBe(
      "x",
    );
  }, 60_000);
});

describe("shipped workflows", () => {
  it("load and validate", async () => {
    const workflows = await loadWorkflows(path.join(here, "../../../workflows"), [
      "claude",
      "codex",
      "gemini",
    ]);
    expect([...workflows.keys()].sort()).toEqual(["bug", "feature"]);
    const bug = workflows.get("bug");
    expect(bug?.steps.map((s) => s.id)).toEqual(["triage", "reproduce", "fix", "review", "docs"]);
    expect(bug?.steps.find((s) => s.id === "triage")?.mode).toBe("consult");
    expect(bug?.steps.find((s) => s.id === "review")?.on).toEqual({
      approved: "docs",
      changes_requested: "fix",
    });
    expect(workflows.get("feature")?.steps.find((s) => s.id === "design")?.consult).toEqual([
      "codex",
    ]);
  });
});
