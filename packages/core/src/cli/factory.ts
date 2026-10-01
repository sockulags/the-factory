// The Factory in the terminal (until the board UI lands).
//
//   pnpm factory product add <KEY> <name>
//   pnpm factory repo add <KEY> <path> [--branch main] [--checks "pnpm test"]
//   pnpm factory card new <KEY> <type> <title> [--body "..."]
//   pnpm factory cards <KEY>
//   pnpm factory card show <CARD>
//   pnpm factory card start|approve|changes|retry|close <CARD> [--comment "..."]
//   pnpm factory card move <CARD> <step>
//
// Commands that run agents stream the conversation and return when the card reaches
// a gate, is blocked or is done. Data: ~/.factory/cli-db, worktrees: ~/.factory/worktrees.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openDb } from "@factory/db";
import { LocalRunner, loadAgents } from "@factory/runner";
import { Board, type Card } from "../board.js";
import type { AgentMessagePayload } from "../events.js";
import { ThreadService } from "../thread-service.js";
import { loadWorkflows } from "../workflow/definition.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { handoverToMarkdown } from "../workflow/handover.js";

const userCwd = process.env.INIT_CWD ?? process.cwd();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    branch: { type: "string" },
    checks: { type: "string", multiple: true },
    body: { type: "string" },
    comment: { type: "string" },
    config: { type: "string" },
    workflows: { type: "string" },
    db: { type: "string" },
  },
});

async function main() {
  const home = path.join(homedir(), ".factory");
  await mkdir(home, { recursive: true });
  const handle = await openDb({ url: values.db ?? `pglite:${path.join(home, "cli-db")}` });
  await handle.migrate();
  const agents = await loadAgents(values.config && path.resolve(userCwd, values.config));
  const runner = new LocalRunner(agents);
  const board = new Board(handle.db);
  const threads = new ThreadService({
    db: handle.db,
    runner,
    turnTimeoutMs: 30 * 60_000,
    handoverFor: (id) => board.handoverForThread(id),
  });
  const engine = new WorkflowEngine({
    board,
    threads,
    runner,
    workflows: await loadWorkflows(
      values.workflows ? path.resolve(userCwd, values.workflows) : path.join(repoRoot, "workflows"),
      agents.map((a) => a.id),
    ),
    worktreesDir: path.join(home, "worktrees"),
  });

  const [group, action, ...args] = positionals;
  const card = async (key: string | undefined) => {
    const found = key ? await board.findCardByKey(key) : null;
    if (!found) throw new Error(`no card "${key}"`);
    return found;
  };
  const product = async (key: string | undefined) => {
    const found = key ? await board.findProductByKey(key) : null;
    if (!found) throw new Error(`no product "${key}"`);
    return found;
  };
  const follow = async (c: Card) => {
    await streamUntilIdle(engine, threads, board, c);
    await printCard(board, (await board.getCard(c.id)) as Card, false);
  };

  try {
    if (group === "product" && action === "add") {
      const p = await board.createProduct({
        key: args[0] ?? "",
        name: args.slice(1).join(" ") || (args[0] ?? ""),
      });
      console.log(`product ${p.key} "${p.name}"`);
    } else if (group === "repo" && action === "add") {
      const p = await product(args[0]);
      const repoPath = path.resolve(userCwd, args[1] ?? ".");
      const r = await board.addRepo({
        productId: p.id,
        name: path.basename(repoPath),
        path: repoPath,
        defaultBranch: values.branch ?? "main",
        checks: values.checks ?? [],
      });
      console.log(
        `repo ${r.name} → ${p.key} (${r.path}, base ${r.defaultBranch}, checks: ${r.checks.join(" && ") || "none"})`,
      );
    } else if (group === "cards") {
      const p = await product(action);
      for (const c of await board.listCards(p.id)) {
        console.log(
          `${c.key.padEnd(8)} ${c.type.padEnd(8)} ${(c.step ?? "backlog").padEnd(10)} ${c.state.padEnd(14)} ${c.title}`,
        );
      }
    } else if (group === "card" && action === "new") {
      const p = await product(args[0]);
      const [repo] = await board.listRepos(p.id);
      engine.workflow(args[1] ?? "");
      const c = await board.createCard({
        productId: p.id,
        repoId: repo?.id ?? null,
        type: args[1] ?? "",
        title: args.slice(2).join(" "),
        body: values.body ?? "",
      });
      console.log(
        `${c.key} created in the backlog. Start it with: pnpm factory card start ${c.key}`,
      );
    } else if (group === "card" && action === "show") {
      await printCard(board, await card(args[0]), true);
    } else if (group === "card" && action === "start") {
      const c = await card(args[0]);
      await engine.start(c.id, "user:cli");
      await follow(c);
    } else if (group === "card" && (action === "approve" || action === "changes")) {
      const c = await card(args[0]);
      await engine.decide(c.id, action === "approve" ? "approved" : "changes_requested", {
        comment: values.comment,
        actor: "user:cli",
      });
      await follow(c);
    } else if (group === "card" && action === "retry") {
      const c = await card(args[0]);
      await engine.retry(c.id, "user:cli");
      await follow(c);
    } else if (group === "card" && action === "move") {
      const c = await card(args[0]);
      await engine.move(c.id, args[1] ?? "", "user:cli");
      await follow(c);
    } else if (group === "card" && action === "close") {
      const c = await card(args[0]);
      await engine.close(c.id, "user:cli");
      await engine.whenIdle(c.id);
      console.log(`${c.key} closed; worktree removed, branch ${c.branch ?? "(none)"} kept.`);
    } else {
      console.log("usage: see the header of packages/core/src/cli/factory.ts");
      process.exitCode = 2;
    }
  } finally {
    await runner.shutdown();
    await handle.close();
  }
}

/** Streams every step thread of the card live until the engine has nothing queued. */
async function streamUntilIdle(
  engine: WorkflowEngine,
  threads: ThreadService,
  board: Board,
  c: Card,
) {
  const subscribed = new Set<string>();
  const unsubscribers: (() => void)[] = [];
  const attach = async () => {
    for (const t of await board.cardThreads(c.id)) {
      if (subscribed.has(t.id)) continue;
      subscribed.add(t.id);
      unsubscribers.push(
        threads.subscribe(t.id, (e) => {
          if (e.type === "turn" && e.state === "started")
            process.stdout.write(`\n\n── ${t.step} · ${e.agentId} ──\n`);
          if (
            e.type === "update" &&
            e.update.sessionUpdate === "agent_message_chunk" &&
            e.update.content.type === "text"
          ) {
            process.stdout.write(e.update.content.text);
          }
          if (e.type === "update" && e.update.sessionUpdate === "tool_call")
            process.stdout.write(`\n  🔧 ${e.update.title}\n`);
          if (e.type === "event" && e.event.kind === "agent_message") {
            const p = e.event.payload as AgentMessagePayload;
            if (p.changes.length)
              process.stdout.write(`\n  [changed ${p.changes.map((x) => x.path).join(", ")}]`);
          }
        }),
      );
    }
  };
  const timer = setInterval(() => void attach(), 500);
  await attach();
  await engine.whenIdle(c.id);
  clearInterval(timer);
  for (const u of unsubscribers) u();
  console.log("\n");
}

async function printCard(board: Board, c: Card, details: boolean) {
  console.log(`${c.key} · ${c.type} · ${c.title}`);
  console.log(
    `step: ${c.step ?? "backlog"} · state: ${c.state}${c.branch ? ` · branch ${c.branch}` : ""}`,
  );
  if (c.worktreePath) console.log(`worktree: ${c.worktreePath}`);
  const last = (await board.events(c.id)).at(-1);
  if (c.state === "blocked" && last) console.log(`blocked: ${JSON.stringify(last.payload)}`);
  if (c.state === "awaiting_gate") {
    console.log(
      `\nWaiting for you: pnpm factory card approve ${c.key}   or   card changes ${c.key} --comment "…"`,
    );
  }
  if (details) {
    for (const h of await board.handovers(c.id))
      console.log(`\n${handoverToMarkdown(h.content, `Handover: ${h.step}`)}`);
    console.log("\nHistory:");
    for (const e of await board.events(c.id)) {
      console.log(
        `  ${e.createdAt.toISOString().slice(11, 19)} ${e.kind.padEnd(16)} ${JSON.stringify(e.payload)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
