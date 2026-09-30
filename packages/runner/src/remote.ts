// The runner protocol: the server drives a runner over HTTP.
//
//   POST /rpc/<method>   body: JSON array of arguments → JSON { result } | { error }
//   POST /rpc/prompt     body: [request] → NDJSON: {"update":…}* then {"result":…} | {"error":…}
//   GET  /agents         → [{ id, name }]
//   GET  /health         → { ok: true }
//
// Everything is authenticated with a shared bearer token. Paths in arguments (worktrees,
// repos) are paths on the runner's machine.

import { timingSafeEqual } from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnResult } from "./agent-process.js";
import type { AgentSpec } from "./agents.js";
import type { Runner } from "./runner.js";

/** Runner methods callable over RPC (everything except the streaming `prompt`). */
const METHODS = [
  "openSession",
  "cancel",
  "checkpoint",
  "diff",
  "ensureWorktree",
  "removeWorktree",
  "exec",
  "commitAll",
  "patch",
  "restorePaths",
  "readDocs",
  "push",
  "remoteUrl",
] as const satisfies readonly (keyof Runner)[];
type Method = (typeof METHODS)[number];

export class RunnerRpcError extends Error {}

/** Serves a Runner over HTTP. Framework-free: plug into any fetch-style server. */
export function createRunnerHandler(runner: Runner, opts: { token: string; agents: AgentSpec[] }) {
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorized = (req: Request) => {
    const given = Buffer.from(req.headers.get("authorization") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (req.method === "GET" && url.pathname === "/agents") {
      return Response.json(opts.agents.map((a) => ({ id: a.id, name: a.name })));
    }
    const method = url.pathname.startsWith("/rpc/") ? url.pathname.slice(5) : "";
    if (req.method !== "POST" || !method)
      return Response.json({ error: "not found" }, { status: 404 });

    let args: unknown[];
    try {
      args = (await req.json()) as unknown[];
      if (!Array.isArray(args)) throw new Error();
    } catch {
      return Response.json({ error: "body must be a JSON array of arguments" }, { status: 400 });
    }

    if (method === "prompt")
      return streamPrompt(runner, args[0] as Parameters<Runner["prompt"]>[0]);
    if (!(METHODS as readonly string[]).includes(method))
      return Response.json({ error: `unknown method ${method}` }, { status: 404 });
    try {
      const fn = runner[method as Method] as (...a: unknown[]) => Promise<unknown>;
      // JSON turns omitted trailing arguments into null; restore them so defaults apply.
      const result = await fn.apply(
        runner,
        args.map((a) => (a === null ? undefined : a)),
      );
      return Response.json({ result: result ?? null });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  };
}

function streamPrompt(runner: Runner, request: Parameters<Runner["prompt"]>[0]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      try {
        const result = await runner.prompt({ ...request, onUpdate: (update) => send({ update }) });
        send({ result });
      } catch (err) {
        send({ error: (err as Error).message });
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

/** A Runner on another machine or pod, reached over the runner protocol. */
export class RemoteRunner implements Runner {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    this.base = url.replace(/\/$/, "");
  }

  /** Agents configured on the runner (the server lists and validates against these). */
  async agents(): Promise<{ id: string; name: string }[]> {
    const res = await this.doFetch(`${this.base}/agents`, { headers: this.headers() });
    if (!res.ok) throw new RunnerRpcError(`runner: GET /agents failed (HTTP ${res.status})`);
    return (await res.json()) as { id: string; name: string }[];
  }

  openSession: Runner["openSession"] = (req) => this.call("openSession", [req]);
  cancel: Runner["cancel"] = (agentId, sessionId) => this.call("cancel", [agentId, sessionId]);
  checkpoint: Runner["checkpoint"] = (cwd, ref, message) =>
    this.call("checkpoint", [cwd, ref, message]);
  diff: Runner["diff"] = (cwd, from, to) => this.call("diff", [cwd, from, to]);
  ensureWorktree: Runner["ensureWorktree"] = (req) => this.call("ensureWorktree", [req]);
  removeWorktree: Runner["removeWorktree"] = (req) => this.call("removeWorktree", [req]);
  exec: Runner["exec"] = (command, cwd, timeoutMs) => this.call("exec", [command, cwd, timeoutMs]);
  commitAll: Runner["commitAll"] = (cwd, message) => this.call("commitAll", [cwd, message]);
  patch: Runner["patch"] = (cwd, from, to, paths) => this.call("patch", [cwd, from, to, paths]);
  restorePaths: Runner["restorePaths"] = (cwd, source, paths) =>
    this.call("restorePaths", [cwd, source, paths]);
  readDocs: Runner["readDocs"] = (cwd, dir) => this.call("readDocs", [cwd, dir]);
  push: Runner["push"] = (cwd, remote, branch, auth) =>
    this.call("push", [cwd, remote, branch, auth]);
  remoteUrl: Runner["remoteUrl"] = (cwd, name) => this.call("remoteUrl", [cwd, name]);

  async prompt(req: Parameters<Runner["prompt"]>[0]): Promise<TurnResult> {
    const { onUpdate, ...request } = req;
    const res = await this.doFetch(`${this.base}/rpc/prompt`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify([request]),
    });
    if (!res.ok || !res.body)
      throw new RunnerRpcError(`runner: prompt failed (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const msg = JSON.parse(line) as {
          update?: SessionUpdate;
          result?: TurnResult;
          error?: string;
        };
        if (msg.update) onUpdate?.(msg.update);
        else if (msg.result) return msg.result;
        else if (msg.error) throw new Error(msg.error);
      }
      if (done) throw new RunnerRpcError("runner: prompt stream ended without a result");
    }
  }

  /** Nothing to shut down locally; the runner owns its agent processes. */
  async shutdown(): Promise<void> {}

  private headers() {
    return { authorization: `Bearer ${this.token}` };
  }

  private async call<T>(method: Method, args: unknown[]): Promise<T> {
    const res = await this.doFetch(`${this.base}/rpc/${method}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok) throw new Error(body.error ?? `runner: ${method} failed (HTTP ${res.status})`);
    return body.result as T;
  }
}
