import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import { AgentProcess, type TurnResult } from "./agent-process.js";
import type { AgentSpec } from "./agents.js";

const exec = promisify(execFile);

export type CheckStatus = "pass" | "fail" | "unsupported" | "error" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  detail: string;
  ms?: number;
}

export const CHECKS = {
  start: "Starts & initializes",
  prompt: "Prompt & streaming",
  usage: "Usage reporting",
  write: "Writes in write mode",
  readOnly: "Read-only enforced",
  cancel: "Cancel",
  resume: "Resume after restart",
} as const;
export type CheckName = keyof typeof CHECKS;

export interface AgentInfo {
  agentInfo: string | null;
  protocolVersion: number;
  authMethods: string[];
  loadSession: boolean;
  sessionCapabilities: string[];
  promptCapabilities: string[];
  modes: string[];
  configOptions: string[];
}

export interface ProbeReport {
  agent: { id: string; name: string };
  startedAt: string;
  info: AgentInfo | null;
  checks: Record<CheckName, CheckResult>;
  stderr: string | null;
}

export interface ProbeOptions {
  /** Per-prompt timeout. Real agents can be slow on a cold start. */
  turnTimeoutMs?: number;
  /** Keep the scratch workspace for inspection. */
  keepWorkspace?: boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

class ProbeAbort extends Error {}

/**
 * Exercises one agent end to end in a scratch git repo and reports what works.
 * Each check maps to something the Factory depends on (see docs/acp-capabilities.md).
 */
export async function probeAgent(
  spec: AgentSpec,
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const timeoutMs = options.turnTimeoutMs ?? 180_000;
  const log = options.log ?? (() => {});
  const checks = Object.fromEntries(
    Object.keys(CHECKS).map((k) => [k, { status: "skipped", detail: "not reached" }]),
  ) as Record<CheckName, CheckResult>;
  const report: ProbeReport = {
    agent: { id: spec.id, name: spec.name },
    startedAt: new Date().toISOString(),
    info: null,
    checks,
    stderr: null,
  };

  const workspace = await createWorkspace();
  let agent: AgentProcess | null = null;
  let updateListener: ((update: SessionUpdate) => void) | null = null;
  const start = () =>
    AgentProcess.start(spec, {
      env: options.env,
      onUpdate: (_id, update) => updateListener?.(update),
    });

  const turn = async (sessionId: string, text: string): Promise<TurnResult> => {
    if (!agent) throw new ProbeAbort("agent not running");
    try {
      return await agent.prompt(sessionId, text, { timeoutMs });
    } catch (err) {
      if (isAuthError(err)) {
        throw new ProbeAbort(`not signed in. ${spec.loginHint ?? ""}`.trim());
      }
      throw err;
    }
  };

  try {
    // 1. Start + initialize
    log("starting agent…");
    const t0 = Date.now();
    try {
      agent = await start();
    } catch (err) {
      checks.start = { status: "error", detail: firstLine(err) };
      throw new ProbeAbort("could not start");
    }
    checks.start = {
      status: "pass",
      detail: agent.init.agentInfo?.name ?? "started",
      ms: Date.now() - t0,
    };

    // 2. Session
    const session = await agent.newSession(workspace, "write");
    const caps = agent.init.agentCapabilities ?? {};
    report.info = {
      agentInfo: agent.init.agentInfo
        ? `${agent.init.agentInfo.name} ${agent.init.agentInfo.version}`
        : null,
      protocolVersion: agent.init.protocolVersion,
      authMethods: (agent.init.authMethods ?? []).map((m) => m.id),
      loadSession: caps.loadSession === true,
      sessionCapabilities: Object.entries(caps.sessionCapabilities ?? {})
        .filter(([k, v]) => v != null && k !== "_meta")
        .map(([k]) => k),
      promptCapabilities: Object.entries(caps.promptCapabilities ?? {})
        .filter(([k, v]) => v === true && k !== "_meta")
        .map(([k]) => k),
      modes: session.modes?.availableModes.map((m) => m.id) ?? [],
      configOptions: (session.configOptions ?? []).map((o) => o.id),
    };
    const sessionId = session.sessionId;

    // 3. Prompt + streaming
    log("prompt…");
    const ping = await turn(sessionId, "Reply with exactly the word PONG and nothing else.");
    const chunks = ping.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").length;
    checks.prompt = ping.text.includes("PONG")
      ? {
          status: "pass",
          detail: `${chunks} chunk(s), stop: ${ping.stopReason}`,
          ms: ping.durationMs,
        }
      : { status: "fail", detail: `unexpected reply: ${truncate(ping.text)}`, ms: ping.durationMs };

    // 4. Usage (from that same turn)
    checks.usage = describeUsage(ping);

    // Plant something to recall after a restart (checked in step 8).
    const codeword = `FACTORY-${randomBytes(3).toString("hex").toUpperCase()}`;
    await turn(sessionId, `Remember this codeword for later: ${codeword}. Reply only with OK.`);

    // 5. Write mode
    log("write mode…");
    const writeFileName = "probe-write.txt";
    const w = await turn(
      sessionId,
      `Create a file named ${writeFileName} in the current directory containing exactly the text: hello from the factory`,
    );
    const written = await exists(path.join(workspace, writeFileName));
    const via = w.writes.includes(writeFileName) ? "via client fs" : "via the agent's own tools";
    checks.write = written
      ? {
          status: "pass",
          detail: `${via}; permission prompts: ${w.permissions.length}`,
          ms: w.durationMs,
        }
      : {
          status: "fail",
          detail: `file not created; reply: ${truncate(w.text)}`,
          ms: w.durationMs,
        };

    // 6. Read-only mode (client-side enforcement only)
    log("read-only mode…");
    agent.setMode(sessionId, "read-only");
    const blockedName = "probe-readonly.txt";
    const r = await turn(
      sessionId,
      `Create a file named ${blockedName} in the current directory containing exactly the text: should be blocked`,
    );
    const leaked = await exists(path.join(workspace, blockedName));
    const rejected = r.permissions.filter((p) => p.decision.startsWith("reject")).length;
    checks.readOnly = leaked
      ? {
          status: "fail",
          detail: `file was created anyway (${r.permissions.length} permission prompt(s), ${r.deniedWrites.length} denied client writes) — needs the agent's own read-only mode`,
          ms: r.durationMs,
        }
      : {
          status: "pass",
          detail: `blocked (${rejected} rejected permission(s), ${r.deniedWrites.length} denied client write(s))`,
          ms: r.durationMs,
        };
    agent.setMode(sessionId, "write");

    // 7. Cancel mid-turn
    log("cancel…");
    checks.cancel = await probeCancel(agent, sessionId, timeoutMs, (l) => {
      updateListener = l;
    });
    updateListener = null;

    // 8. Resume in a fresh process
    log("restart + resume…");
    await agent.close();
    agent = await start();
    const info = report.info;
    let how: string;
    let replayed = 0;
    if (info.loadSession) {
      const loaded = await agent.loadSession(sessionId, workspace, "write");
      replayed = loaded.replayed.length;
      how = `session/load (replayed ${replayed} update(s))`;
    } else if (info.sessionCapabilities.includes("resume")) {
      await agent.resumeSession(sessionId, workspace, "write");
      how = "session/resume";
    } else {
      checks.resume = {
        status: "unsupported",
        detail: "neither session/load nor session/resume advertised",
      };
      throw new ProbeAbort("done");
    }
    const recall = await turn(
      sessionId,
      "What was the codeword I asked you to remember? Reply with only the codeword.",
    );
    checks.resume = recall.text.includes(codeword)
      ? { status: "pass", detail: how, ms: recall.durationMs }
      : {
          status: "fail",
          detail: `${how}, but the codeword was not recalled: ${truncate(recall.text)}`,
        };
  } catch (err) {
    if (!(err instanceof ProbeAbort)) {
      const pending = (Object.keys(checks) as CheckName[]).find(
        (k) => checks[k].status === "skipped",
      );
      if (pending) checks[pending] = { status: "error", detail: firstLine(err) };
    } else if (err.message !== "done" && err.message !== "could not start") {
      const pending = (Object.keys(checks) as CheckName[]).find(
        (k) => checks[k].status === "skipped",
      );
      if (pending) checks[pending] = { status: "error", detail: err.message };
    }
  } finally {
    report.stderr = agent?.stderr || null;
    await agent?.close();
    if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
    else log(`workspace kept at ${workspace}`);
  }
  return report;
}

async function probeCancel(
  agent: AgentProcess,
  sessionId: string,
  timeoutMs: number,
  setListener: (l: ((u: SessionUpdate) => void) | null) => void,
): Promise<CheckResult> {
  let cancelledAt = 0;
  const firstOutput = new Promise<void>((resolve) => setListener(() => resolve()));
  const running = agent.prompt(
    sessionId,
    "Count from 1 to 400, one number per line. Do not use any tools.",
    {
      timeoutMs,
    },
  );
  // Cancel on the first streamed output, or after 5s if nothing streams.
  await Promise.race([firstOutput, new Promise((r) => setTimeout(r, 5000))]);
  cancelledAt = Date.now();
  await agent.cancel(sessionId);
  const settled = await Promise.race([
    running.then((t) => t),
    new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
  ]);
  const ms = Date.now() - cancelledAt;
  if (!settled) return { status: "fail", detail: "turn did not end within 15s of session/cancel" };
  return settled.stopReason === "cancelled"
    ? { status: "pass", detail: `stopped ${ms} ms after cancel`, ms }
    : {
        status: "fail",
        detail: `turn ended with "${settled.stopReason}" instead of "cancelled"`,
        ms,
      };
}

function describeUsage(turn: TurnResult): CheckResult {
  const parts: string[] = [];
  if (turn.usage)
    parts.push(`tokens in ${turn.usage.inputTokens} / out ${turn.usage.outputTokens}`);
  if (turn.contextUsage) {
    parts.push(`context ${turn.contextUsage.used}/${turn.contextUsage.size}`);
    if (turn.contextUsage.cost)
      parts.push(`cost ${turn.contextUsage.cost.amount} ${turn.contextUsage.cost.currency}`);
  }
  return parts.length
    ? { status: "pass", detail: parts.join(", ") }
    : { status: "unsupported", detail: "no usage in the prompt response and no usage_update" };
}

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-probe-"));
  await writeFile(
    path.join(dir, "README.md"),
    "# Probe workspace\n\nScratch repo created by the Factory ACP probe.\n",
  );
  try {
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["add", "."], { cwd: dir });
    await exec(
      "git",
      ["-c", "user.name=probe", "-c", "user.email=probe@localhost", "commit", "-qm", "init"],
      {
        cwd: dir,
      },
    );
  } catch {
    // git is optional for the probe
  }
  return dir;
}

function isAuthError(err: unknown): boolean {
  if (err instanceof RequestError && err.code === -32000) return true;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("auth") &&
    (msg.includes("required") || msg.includes("login") || msg.includes("not logged"))
  );
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function firstLine(err: unknown): string {
  return truncate(String((err as Error)?.message ?? err).split("\n")[0] ?? "", 200);
}

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean || "(empty)";
}
