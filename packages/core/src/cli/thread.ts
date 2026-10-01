// Multi-agent thread in the terminal: the phase 2 model switch, without the UI.
//
//   pnpm thread [--cwd repo] [--title "…"] [--thread <id>] [--agents claude,codex] [--config agents.json]
//
//   @claude fix the failing test      → Claude drives (may edit files)
//   ?codex is this approach sound?    → Codex is consulted read-only
//   plain text                        → same agent and mode as the last message
//   /log  /threads  /cancel  /quit
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { openDb, schema } from "@factory/db";
import { LocalRunner, loadAgents } from "@factory/runner";
import { desc } from "drizzle-orm";
import type { AgentMessagePayload, TurnMode } from "../events.js";
import { ThreadService } from "../thread-service.js";

const userCwd = process.env.INIT_CWD ?? process.cwd();
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    cwd: { type: "string", default: "." },
    title: { type: "string" },
    thread: { type: "string" },
    agents: { type: "string", default: "claude,codex" },
    config: { type: "string" },
    db: { type: "string" },
  },
});

async function main() {
  const dataDir = path.join(homedir(), ".factory");
  await mkdir(dataDir, { recursive: true });
  const handle = await openDb({ url: values.db ?? `pglite:${path.join(dataDir, "cli-db")}` });
  await handle.migrate();

  const all = await loadAgents(values.config && path.resolve(userCwd, values.config));
  const wanted = (values.agents ?? "").split(/[\s,]+/).map((s) => s.trim());
  const agents = all.filter((a) => wanted.includes(a.id));
  const runner = new LocalRunner(agents);
  const service = new ThreadService({ db: handle.db, runner, turnTimeoutMs: 15 * 60_000 });

  const thread = values.thread
    ? await service.getThread(values.thread)
    : await service.createThread({
        title: values.title ?? `CLI thread ${new Date().toISOString().slice(0, 16)}`,
        cwd: path.resolve(userCwd, values.cwd ?? "."),
      });
  if (!thread) throw new Error(`no thread ${values.thread}`);

  console.log(`thread ${thread.id}  "${thread.title}"\nworktree ${thread.cwd}`);
  console.log(
    `agents: ${agents.map((a) => a.id).join(", ")}   (@agent = drive, ?agent = consult read-only)\n`,
  );

  service.subscribe(thread.id, (e) => {
    if (e.type === "update") {
      const u = e.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
        process.stdout.write(u.content.text);
      else if (u.sessionUpdate === "tool_call") process.stdout.write(`\n  🔧 ${u.title}\n`);
    } else if (e.type === "turn" && e.state === "started") {
      process.stdout.write(`\n[${e.agentId}] `);
    } else if (e.type === "event" && e.event.kind === "agent_message") {
      const p = e.event.payload as AgentMessagePayload;
      const changes = p.changes.length
        ? ` · changed ${p.changes.map((c) => c.path).join(", ")}`
        : "";
      const tokens = p.usage ? ` · ${p.usage.inputTokens}→${p.usage.outputTokens} tok` : "";
      console.log(
        `\n  [${p.stopReason} · ${p.sessionOrigin} session · ${(p.durationMs / 1000).toFixed(1)}s${tokens}${changes}]`,
      );
    }
  });

  let agentId = agents[0]?.id ?? "claude";
  let mode: TurnMode = "write";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    if (service.isRunning(thread.id)) {
      console.log("\n(cancelling…)");
      void service.cancel(thread.id);
    } else rl.close();
  });

  const handleLine = async (line: string): Promise<void> => {
    if (!line) return;
    if (line === "/cancel") {
      await service.cancel(thread.id);
      return;
    }
    if (line === "/log") {
      for (const e of await service.events(thread.id)) {
        const text =
          "text" in e.payload ? e.payload.text : (e.payload as { message: string }).message;
        console.log(
          `${String(e.seq).padStart(3)} ${e.actor.padEnd(14)} ${e.kind.padEnd(14)} ${text.slice(0, 80).replace(/\n/g, " ")}`,
        );
      }
      return;
    }
    if (line === "/threads") {
      const rows = await handle.db
        .select()
        .from(schema.threads)
        .orderBy(desc(schema.threads.createdAt))
        .limit(20);
      for (const t of rows) console.log(`${t.id}  ${t.title}  (${t.cwd})`);
      return;
    }
    const addressed: RegExpMatchArray | null = line.match(/^([@?])(\S+)\s+([\s\S]+)$/);
    let text = line;
    if (addressed) {
      const sigil: string = addressed[1] ?? "@";
      const id: string = addressed[2] ?? "";
      if (!agents.some((a) => a.id === id)) {
        console.log(`unknown agent "${id}"`);
        return;
      }
      agentId = id;
      mode = sigil === "?" ? "consult" : "write";
      text = addressed[3] ?? "";
    }
    try {
      await service.send({ threadId: thread.id, agentId, text, mode });
    } catch (err) {
      console.log(`\n  ⚠ ${(err as Error).message.split("\n")[0]}`);
    }
  };

  const prompt = () => {
    rl.setPrompt(`\n${mode === "consult" ? "?" : "@"}${agentId} › `);
    rl.prompt();
  };
  try {
    prompt();
    for await (const raw of rl) {
      const line: string = raw.trim();
      if (line === "/quit") break;
      await handleLine(line);
      prompt();
    }
  } finally {
    rl.close();
    await runner.shutdown();
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
