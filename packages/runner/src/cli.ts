// Factory runner CLI (phase 1 spike).
//
//   probe [--agents claude,codex] [--config agents.json] [--out file.md] [--json file.json]
//         [--timeout 180] [--keep]
//   chat <agent> [--cwd dir] [--read-only] [--config agents.json]
import { writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AgentProcess } from "./agent-process.js";
import { type AgentSpec, loadAgents } from "./agents.js";
import { type ProbeReport, probeAgent } from "./probe.js";
import { renderMarkdown, renderSummary } from "./report.js";

const [command, ...rest] = process.argv.slice(2);
// pnpm runs scripts from the package directory; resolve user paths against where they ran it.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const fromUser = (p: string) => path.resolve(userCwd, p);

async function main() {
  if (command === "probe") return probe();
  if (command === "chat") return chat();
  console.error("usage: cli.ts probe|chat [options]  (see file header)");
  process.exitCode = 2;
}

async function probe() {
  const { values } = parseArgs({
    args: rest,
    options: {
      agents: { type: "string", default: "claude,codex" },
      config: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      timeout: { type: "string", default: "180" },
      keep: { type: "boolean", default: false },
    },
  });
  const all = await loadAgents(values.config && fromUser(values.config));
  const wanted = (values.agents ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const specs = wanted.map((id) => {
    const spec = all.find((a) => a.id === id);
    if (!spec) throw new Error(`unknown agent "${id}" (known: ${all.map((a) => a.id).join(", ")})`);
    return spec;
  });

  const reports: ProbeReport[] = [];
  for (const spec of specs) {
    console.log(`\n▶ ${spec.name}`);
    const report = await probeAgent(spec, {
      turnTimeoutMs: Number(values.timeout) * 1000,
      keepWorkspace: values.keep,
      log: (line) => console.log(`  … ${line}`),
    });
    reports.push(report);
    console.log(renderSummary(report));
    if (report.checks.start.status !== "pass" && report.stderr)
      console.log(`  stderr:\n${indent(report.stderr)}`);
  }

  const meta = {
    host: `${platform()} (${hostname()})`,
    date: new Date().toISOString().slice(0, 10),
  };
  if (values.out) {
    await writeFile(fromUser(values.out), renderMarkdown(reports, meta));
    console.log(`\nwrote ${fromUser(values.out)}`);
  }
  if (values.json) {
    await writeFile(fromUser(values.json), JSON.stringify({ ...meta, reports }, null, 2));
    console.log(`wrote ${fromUser(values.json)}`);
  }
}

async function chat() {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      cwd: { type: "string", default: userCwd },
      "read-only": { type: "boolean", default: false },
      config: { type: "string" },
    },
  });
  const id = positionals[0] ?? "claude";
  const spec: AgentSpec | undefined = (
    await loadAgents(values.config && fromUser(values.config))
  ).find((a) => a.id === id);
  if (!spec) throw new Error(`unknown agent "${id}"`);
  const cwd = fromUser(values.cwd ?? ".");

  const agent = await AgentProcess.start(spec, {
    onUpdate: (_id, u) => {
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
        process.stdout.write(u.content.text);
      else if (u.sessionUpdate === "tool_call") process.stdout.write(`\n  🔧 ${u.title}\n`);
    },
  });
  const mode = values["read-only"] ? "read-only" : "write";
  const { sessionId } = await agent.newSession(cwd, mode);
  console.log(
    `${spec.name} · ${mode} · ${cwd}\nsession ${sessionId}. Empty line or Ctrl+C to quit.\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = (await rl.question("\n› ")).trim();
      if (!line) break;
      const turn = await agent.prompt(sessionId, line);
      const usage = turn.usage
        ? ` · ${turn.usage.inputTokens}→${turn.usage.outputTokens} tokens`
        : "";
      console.log(`\n  [${turn.stopReason} · ${(turn.durationMs / 1000).toFixed(1)}s${usage}]`);
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
