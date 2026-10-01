import path from "node:path";
import type { Runner } from "@factory/runner";
import type { Board, Card, CardState, Repo } from "../board.js";
import { docsIndex, relevantDocs } from "../docs-context.js";
import { type AgentMessagePayload, WORKFLOW_ACTOR } from "../events.js";
import type { ThreadService } from "../thread-service.js";
import {
  DONE,
  nextStepId,
  type StepDefinition,
  stepById,
  type WorkflowDefinition,
} from "./definition.js";
import { type HandoverContent, handoverToMarkdown, parseHandover } from "./handover.js";
import { renderTemplate } from "./template.js";

export type GateDecision = "approved" | "changes_requested";

/** Where product docs live in a repo; the docs step may only change this directory. */
export const DOCS_DIR = "docs";

/** A request that isn't valid in the card's current state. Reported to the caller. */
export class WorkflowError extends Error {}

/** A named action workflows can run on step enter/exit; plugins provide them. */
export type Hook = (ctx: {
  card: Card;
  step: StepDefinition;
  repo: Repo | null;
  board: Board;
  runner: Runner;
}) => Promise<Record<string, unknown> | undefined>;

export interface WorkflowEngineOptions {
  board: Board;
  threads: ThreadService;
  runner: Runner;
  workflows: Map<string, WorkflowDefinition>;
  /** Where card worktrees are created: <worktreesDir>/<card-key>. */
  worktreesDir: string;
  /** Hooks available to every product (tests, built-ins). */
  hooks?: Record<string, Hook>;
  /** Hooks from the card's product's plugins. */
  resolveHook?: (card: Card, name: string) => Promise<Hook | null>;
  /** Product instructions (plugins) prepended to each step's first prompt. */
  instructionsFor?: (card: Card) => Promise<string>;
  /** Notified whenever a card changes (board live updates). */
  onCardChange?: (cardId: string) => void;
}

type Actor = string;

/**
 * Runs cards through their type's workflow. Each step owns one thread; re-entering a
 * step (e.g. review → fix on "changes requested") continues that thread with the new
 * input. Every step ends with a structured handover, then its gate decides what happens.
 *
 * Operations on a card are queued, so a gate decision can't race a running step.
 * Methods return once the operation is queued; `whenIdle(cardId)` waits for it to finish.
 */
export class WorkflowEngine {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: WorkflowEngineOptions) {}

  workflow(type: string): WorkflowDefinition {
    const wf = this.options.workflows.get(type);
    if (!wf) throw new WorkflowError(`no workflow for card type "${type}"`);
    return wf;
  }

  /** Moves a backlog card into its first step. */
  async start(cardId: string, actor: Actor = "system"): Promise<void> {
    const check = (card: Card) => {
      if (card.state !== "backlog") throw new WorkflowError(`${card.key} has already started`);
      if (!this.workflow(card.type).steps[0]) throw new WorkflowError("workflow has no steps");
    };
    check(await this.card(cardId));
    this.enqueue(cardId, async () => {
      const card = await this.card(cardId);
      check(card);
      const first = this.workflow(card.type).steps[0] as StepDefinition;
      await this.options.board.addEvent(card.id, "started", actor, { step: first.id });
      await this.runStep(card, first.id, null);
    });
  }

  /** A person's decision at a human gate (or overriding a blocked step). */
  async decide(
    cardId: string,
    decision: GateDecision,
    opts: { comment?: string; actor?: Actor; discardDocs?: boolean } = {},
  ): Promise<void> {
    const check = (card: Card) => {
      if (card.state !== "awaiting_gate" && card.state !== "blocked") {
        throw new WorkflowError(`${card.key} is not waiting for a decision (state: ${card.state})`);
      }
    };
    check(await this.card(cardId));
    this.enqueue(cardId, async () => {
      const card = await this.card(cardId);
      check(card);
      await this.options.board.addEvent(card.id, "gate_decided", opts.actor ?? "system", {
        step: card.step,
        decision,
        comment: opts.comment ?? null,
        ...(opts.discardDocs ? { discardDocs: true } : {}),
      });
      await this.complete(card, decision, opts.comment ?? null, {
        actor: opts.actor ?? "system",
        discardDocs: opts.discardDocs ?? false,
      });
    });
  }

  /** Re-runs the current step after an error (continues its thread). */
  async retry(cardId: string, actor: Actor = "system"): Promise<void> {
    const check = (card: Card) => {
      if (!card.step || card.state !== "blocked")
        throw new WorkflowError(`${card.key} is not blocked`);
    };
    check(await this.card(cardId));
    this.enqueue(cardId, async () => {
      const card = await this.card(cardId);
      check(card);
      await this.options.board.addEvent(card.id, "retried", actor, { step: card.step });
      await this.runStep(
        card,
        card.step as string,
        "Please try again: the previous attempt at this step did not finish.",
      );
    });
  }

  /** Manually moves a card to a step (drag on the board). Runs that step. */
  async move(cardId: string, step: string, actor: Actor = "system"): Promise<void> {
    const check = (card: Card) => {
      if (card.state === "running")
        throw new WorkflowError(`${card.key} is busy; wait or cancel first`);
      if (card.state === "closed") throw new WorkflowError(`${card.key} is closed`);
      if (!this.workflow(card.type).steps.some((s) => s.id === step)) {
        throw new WorkflowError(`workflow "${card.type}" has no step "${step}"`);
      }
    };
    check(await this.card(cardId));
    this.enqueue(cardId, async () => {
      const card = await this.card(cardId);
      check(card);
      await this.options.board.addEvent(card.id, "moved", actor, { from: card.step, to: step });
      await this.runStep(
        card,
        step,
        card.step ? `The card was moved here from "${card.step}" by a person.` : null,
      );
    });
  }

  /** Closes a card: removes its worktree and snapshot refs. The branch stays. */
  async close(cardId: string, actor: Actor = "system"): Promise<void> {
    const check = (card: Card) => {
      if (card.state === "running")
        throw new WorkflowError(`${card.key} is busy; wait or cancel first`);
    };
    check(await this.card(cardId));
    this.enqueue(cardId, async () => {
      const card = await this.card(cardId);
      check(card);
      const repo = card.repoId ? await this.options.board.getRepo(card.repoId) : null;
      if (repo && card.worktreePath) {
        const threads = await this.options.board.cardThreads(card.id);
        await this.options.runner.removeWorktree({
          repoPath: repo.path,
          worktreePath: card.worktreePath,
          refPrefixes: [
            ...threads.map((t) => `refs/factory/threads/${t.id}`),
            `refs/factory/cards/${card.id}`,
          ],
        });
      }
      await this.options.board.updateCard(card.id, { state: "closed", worktreePath: null });
      await this.options.board.addEvent(card.id, "closed", actor, {});
      this.changed(card.id);
    });
  }

  /**
   * Call once at startup. Cards that were mid-step when the server stopped lost their
   * agent turn; each is resumed in its step's thread (the agent sees the cut-off turn in
   * its delta). A card interrupted again before its resumed step got anywhere is blocked
   * instead, so a step that crashes the server can't loop. Returns the affected card keys.
   */
  async recover(): Promise<string[]> {
    const { board, runner } = this.options;
    const stuck = await board.cardsInState("running");
    for (const card of stuck) {
      const step = card.step;
      // With a remote runner the agent may still be working on the old turn: stop it.
      const thread = step ? await board.stepThread(card.id, step) : null;
      if (thread) {
        for (const s of await this.options.threads.sessions(thread.id)) {
          await runner.cancel(s.agentId, s.acpSessionId).catch(() => undefined);
        }
      }
      const progress = (await board.events(card.id)).filter((e) => e.kind !== "step_started");
      const again = progress.at(-1)?.kind === "interrupted";
      await board.addEvent(card.id, "interrupted", "system", { step, resumed: !again && !!step });
      if (again || !step) {
        await board.updateCard(card.id, { state: "blocked" });
        await board.addEvent(card.id, "error", "system", {
          step,
          message: again
            ? "The server restarted twice while this step was running. Press Retry to run it again."
            : "The server restarted while this card was running.",
        });
        this.changed(card.id);
        continue;
      }
      this.enqueue(card.id, async () => {
        await this.runStep(
          await this.card(card.id),
          step,
          "The Factory restarted while you were working on this step, so your last turn was cut off. Check the worktree for what you already did, then finish the step.",
        );
      });
    }
    return stuck.map((c) => c.key);
  }

  /** Resolves when every queued operation for the card has finished. */
  async whenIdle(cardId: string): Promise<void> {
    while (this.queues.has(cardId)) await this.queues.get(cardId);
  }

  isBusy(cardId: string): boolean {
    return this.queues.has(cardId);
  }

  /** Runs `op` after the card's previous operations. Never rejects: failures block the card. */
  private enqueue(cardId: string, op: () => Promise<void>): void {
    const previous = this.queues.get(cardId) ?? Promise.resolve();
    const settled = previous.then(op).catch(async (err: Error) => {
      const card = await this.options.board.getCard(cardId).catch(() => null);
      if (!card || card.state === "closed") return;
      if (err instanceof WorkflowError) {
        // The request became invalid while queued (e.g. two decisions at once): record, don't block.
        await this.options.board.addEvent(cardId, "skipped", "system", { message: err.message });
        return;
      }
      await this.options.board.updateCard(cardId, { state: "blocked" });
      await this.options.board.addEvent(cardId, "error", "system", {
        step: card.step,
        message: err.message,
      });
      this.changed(cardId);
    });
    this.queues.set(cardId, settled);
    void settled.then(() => {
      if (this.queues.get(cardId) === settled) this.queues.delete(cardId);
    });
  }

  private async runStep(card: Card, stepId: string, input: string | null): Promise<void> {
    const { board, threads } = this.options;
    const wf = this.workflow(card.type);
    const step = stepById(wf, stepId);
    const repo = card.repoId ? await board.getRepo(card.repoId) : null;
    card = await this.setState(card, "running", stepId);
    await board.addEvent(card.id, "step_started", "system", {
      step: step.id,
      reentry: input != null,
    });
    await this.runHooks(card, step, repo, "enter");

    const cwd = await this.ensureWorktree(card, repo);
    const proposesDocs = step.outputs.includes("doc_proposal") && repo != null;
    // Doc proposals cover everything since the step was first entered (across re-entries).
    const docsBase = proposesDocs
      ? ((await board.pendingDocProposal(card.id, step.id))?.baseCheckpoint ??
        (await this.options.runner.checkpoint(
          cwd,
          `refs/factory/cards/${card.id}/${step.id}-base`,
          "docs base",
        )))
      : null;
    let thread = await board.stepThread(card.id, step.id);
    let message: string;
    if (!thread) {
      thread = await threads.createThread({
        title: `${card.key} · ${step.name}`,
        cwd,
        cardId: card.id,
        step: step.id,
      });
      message = await this.renderStepPrompt(card, step, repo, input);
      const instructions = await this.options.instructionsFor?.(card);
      if (instructions) message = `${message}\n\n## Product instructions\n${instructions}`;
    } else {
      message = input ?? "Continue with this step.";
    }

    const mode = step.mode;
    await threads.send({
      actor: WORKFLOW_ACTOR,
      threadId: thread.id,
      agentId: step.agent,
      text: message,
      mode,
    });
    if (step.consult.length) {
      const consult = renderTemplate(wf.shared.consult, { driver: step.agent });
      for (const agentId of step.consult) {
        await threads.send({
          actor: WORKFLOW_ACTOR,
          threadId: thread.id,
          agentId,
          text: consult,
          mode: "consult",
        });
      }
      await threads.send({
        actor: WORKFLOW_ACTOR,
        threadId: thread.id,
        agentId: step.agent,
        text: wf.shared.revise,
        mode,
      });
    }

    const content = await this.collectHandover(thread.id, step, wf);
    await board.saveHandover({ cardId: card.id, step: step.id, threadId: thread.id, content });
    await board.addEvent(card.id, "handover", `agent:${step.agent}`, {
      step: step.id,
      format: content.format,
    });
    if (docsBase) await this.proposeDocs(card, step, thread.id, cwd, docsBase);

    await this.gate(card, step, repo, cwd);
  }

  private async gate(
    card: Card,
    step: StepDefinition,
    repo: Repo | null,
    cwd: string,
  ): Promise<void> {
    const { board, runner } = this.options;
    if (step.gate === "auto") return this.complete(card, "approved", null);
    if (step.gate === "human") {
      await this.setState(card, "awaiting_gate", step.id);
      return;
    }
    // checks
    const commands = repo?.checks ?? [];
    const results = [];
    for (const command of commands) {
      const result = await runner.exec(command, cwd);
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    const failed = results.find((r) => r.exitCode !== 0);
    await board.addEvent(card.id, failed ? "checks_failed" : "checks_passed", "system", {
      step: step.id,
      results: results.map((r) => ({
        command: r.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
      })),
    });
    if (!failed) return this.complete(card, "approved", null);

    const attempts = (await board.events(card.id)).filter(
      (e) => e.kind === "checks_failed" && (e.payload as { step?: string }).step === step.id,
    ).length;
    if (attempts >= step.maxCheckAttempts) {
      await this.setState(card, "blocked", step.id);
      await board.addEvent(card.id, "blocked", "system", {
        step: step.id,
        reason: `checks still failing after ${attempts} attempts`,
      });
      return;
    }
    await this.runStep(
      card,
      step.id,
      `The checks failed (attempt ${attempts} of ${step.maxCheckAttempts}):\n\n$ ${failed.command}\n\`\`\`\n${failed.output}\n\`\`\`\n\nFix the problems so the checks pass.`,
    );
  }

  private async complete(
    card: Card,
    decision: GateDecision,
    comment: string | null,
    opts: { actor?: Actor; discardDocs?: boolean } = {},
  ): Promise<void> {
    const { board } = this.options;
    card = await this.card(card.id); // callers may hold a copy from before the worktree existed
    const wf = this.workflow(card.type);
    if (!card.step) throw new Error(`${card.key} is not in a step`);
    const step = stepById(wf, card.step);
    const repo = card.repoId ? await board.getRepo(card.repoId) : null;
    const target =
      step.on[decision] ?? (decision === "approved" ? nextStepId(wf, step.id) : step.id);

    if (decision === "approved") {
      await this.settleDocProposal(card, step, opts);
      await this.commitStep(card, step);
      await this.runHooks(card, step, repo, "exit");
    }
    await board.addEvent(card.id, "step_completed", "system", {
      step: step.id,
      decision,
      next: target,
    });

    if (target === DONE) {
      await this.setState(card, "done", step.id);
      return;
    }
    let input: string | null = null;
    if (decision === "changes_requested") {
      const handover = await board.latestHandover(card.id, { step: step.id });
      const parts = [`Changes were requested at "${step.name}".`];
      if (comment) parts.push(`Comment from the reviewer:\n${comment}`);
      if (handover && target !== step.id)
        parts.push(handoverToMarkdown(handover.content, `Handover from ${step.name}`));
      parts.push("Address this, then summarize what you changed.");
      input = parts.join("\n\n");
    } else if (await board.stepThread(card.id, target)) {
      // Re-entering an earlier step on approval (a loop in the workflow).
      input = `The workflow returned to this step after "${step.name}" was approved. Continue from where you left off.`;
    }
    await this.runStep(card, target, input);
  }

  /** Turns the docs step's worktree changes into a proposal for a person to review. */
  private async proposeDocs(
    card: Card,
    step: StepDefinition,
    threadId: string,
    cwd: string,
    base: string,
  ) {
    const { board, runner } = this.options;
    const head = await runner.checkpoint(
      cwd,
      `refs/factory/cards/${card.id}/${step.id}-head`,
      "docs head",
    );
    if (!head) return;
    const all = await runner.diff(cwd, base, head);
    const inDocs = all.files.filter(
      (f) => f.path === DOCS_DIR || f.path.startsWith(`${DOCS_DIR}/`),
    );
    const outsideDocs = all.files.filter((f) => !inDocs.includes(f)).map((f) => f.path);
    const { patch } = await runner.patch(cwd, base, head, [DOCS_DIR]);
    const proposal = await board.saveDocProposal({
      cardId: card.id,
      step: step.id,
      threadId,
      baseCheckpoint: base,
      headCheckpoint: head,
      patch,
      files: inDocs,
      outsideDocs,
    });
    await board.addEvent(card.id, "docs_proposed", `agent:${step.agent}`, {
      step: step.id,
      proposal: proposal.id,
      files: inDocs.length,
      outsideDocs: outsideDocs.length,
    });
  }

  /** On approval: accept the pending doc proposal, or revert it if the reviewer discarded it. */
  private async settleDocProposal(
    card: Card,
    step: StepDefinition,
    opts: { actor?: Actor; discardDocs?: boolean },
  ) {
    const { board, runner } = this.options;
    const pending = await board.pendingDocProposal(card.id, step.id);
    if (!pending) return;
    if (opts.discardDocs && card.worktreePath) {
      await runner.restorePaths(card.worktreePath, pending.baseCheckpoint, [DOCS_DIR]);
      await board.reviewDocProposal(pending.id, "discarded", opts.actor ?? "system");
      await board.addEvent(card.id, "docs_discarded", opts.actor ?? "system", {
        step: step.id,
        proposal: pending.id,
      });
    } else {
      await board.reviewDocProposal(pending.id, "approved", opts.actor ?? "system");
      await board.addEvent(card.id, "docs_approved", opts.actor ?? "system", {
        step: step.id,
        proposal: pending.id,
      });
    }
  }

  /** Commits what an approved write step changed, so the branch tells the story step by step. */
  private async commitStep(card: Card, step: StepDefinition) {
    if (step.mode !== "write" || !card.worktreePath || !card.repoId) return;
    const handover = await this.options.board.latestHandover(card.id, { step: step.id });
    const goal = handover?.content.format === "structured" ? handover.content.handover.goal : "";
    const subject = `${card.key} ${step.name}: ${goal || card.title}`.replace(/\s+/g, " ");
    const message = `${subject.length > 72 ? `${subject.slice(0, 71)}…` : subject}\n\nCard: ${card.key} — ${card.title}\nStep: ${step.name}`;
    const commit = await this.options.runner.commitAll(card.worktreePath, message);
    if (commit)
      await this.options.board.addEvent(card.id, "committed", "system", { step: step.id, commit });
  }

  private async collectHandover(
    threadId: string,
    step: StepDefinition,
    wf: WorkflowDefinition,
  ): Promise<HandoverContent> {
    const { threads } = this.options;
    const ask = async (text: string) => {
      const reply = await threads.send({
        actor: WORKFLOW_ACTOR,
        threadId,
        agentId: step.agent,
        text,
        mode: "consult",
      });
      return (reply.payload as AgentMessagePayload).text;
    };
    const first = await ask(
      renderTemplate(wf.shared.handover, { step: { id: step.id, name: step.name } }),
    );
    const parsed = parseHandover(first);
    if (parsed.ok) return { format: "structured", handover: parsed.handover };
    const second = await ask(
      `That handover could not be used: ${parsed.error}. Reply again with only the JSON object in a \`\`\`json block, following the format exactly.`,
    );
    const retry = parseHandover(second);
    if (retry.ok) return { format: "structured", handover: retry.handover };
    return { format: "raw", text: second || first, error: retry.error };
  }

  private async renderStepPrompt(
    card: Card,
    step: StepDefinition,
    repo: Repo | null,
    input: string | null,
  ) {
    const { board } = this.options;
    const previous = await board.latestHandover(card.id, { excludeStep: step.id });
    const docs = card.worktreePath
      ? await this.options.runner.readDocs(card.worktreePath, DOCS_DIR)
      : [];
    const previousGoal =
      previous?.content.format === "structured" ? previous.content.handover.goal : "";
    return renderTemplate(step.promptTemplate, {
      docs: {
        dir: DOCS_DIR,
        index: docsIndex(docs),
        relevant: relevantDocs(docs, `${card.title}\n${card.body}\n${previousGoal}`),
      },
      card: { key: card.key, title: card.title, body: card.body, type: card.type },
      step: { id: step.id, name: step.name },
      repo: repo
        ? {
            name: repo.name,
            branch: card.branch,
            base: repo.defaultBranch,
            checks: repo.checks.join(" && "),
          }
        : null,
      handover: {
        previous: previous
          ? handoverToMarkdown(previous.content, `Handover from ${previous.step}`)
          : "",
      },
      input: input ?? "",
    });
  }

  private async ensureWorktree(card: Card, repo: Repo | null): Promise<string> {
    if (!repo) return this.options.worktreesDir;
    if (card.worktreePath && card.branch) {
      await this.options.runner.ensureWorktree({
        repoPath: repo.path,
        worktreePath: card.worktreePath,
        branch: card.branch,
        base: repo.defaultBranch,
      });
      return card.worktreePath;
    }
    const branch = `factory/${card.key.toLowerCase()}-${slug(card.title)}`;
    const worktreePath = path.join(this.options.worktreesDir, card.key.toLowerCase());
    await this.options.runner.ensureWorktree({
      repoPath: repo.path,
      worktreePath,
      branch,
      base: repo.defaultBranch,
    });
    await this.options.board.updateCard(card.id, { branch, worktreePath });
    await this.options.board.addEvent(card.id, "worktree_created", "system", {
      branch,
      path: worktreePath,
    });
    return worktreePath;
  }

  private async runHooks(
    card: Card,
    step: StepDefinition,
    repo: Repo | null,
    phase: "enter" | "exit",
  ) {
    for (const name of step.hooks[phase]) {
      const hook =
        this.options.hooks?.[name] ?? (await this.options.resolveHook?.(card, name)) ?? null;
      if (!hook) {
        await this.options.board.addEvent(card.id, "hook_skipped", "system", {
          hook: name,
          reason: "no enabled plugin provides this hook",
        });
        continue;
      }
      const result = await hook({
        card,
        step,
        repo,
        board: this.options.board,
        runner: this.options.runner,
      });
      await this.options.board.addEvent(card.id, "hook_ran", "system", {
        hook: name,
        phase,
        result: result ?? null,
      });
    }
  }

  private async setState(card: Card, state: CardState, step: string): Promise<Card> {
    const updated = await this.options.board.updateCard(card.id, { state, step });
    this.changed(card.id);
    return updated;
  }

  private async card(cardId: string): Promise<Card> {
    const card = await this.options.board.getCard(cardId);
    if (!card) throw new WorkflowError(`unknown card ${cardId}`);
    return card;
  }

  private changed(cardId: string) {
    this.options.onCardChange?.(cardId);
  }
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "work"
  );
}
