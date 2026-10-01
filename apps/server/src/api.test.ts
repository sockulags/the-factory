import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type DbHandle, openDb } from "@factory/db";
import type {
  CardDetailDto,
  CardDto,
  ProductDto,
  RepoDto,
  ThreadDetailDto,
  WorkflowDto,
} from "@factory/protocol";
import type { AgentSpec } from "@factory/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createDevAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { createFactoryServices, type FactoryServices } from "./services.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const tsx = createRequire(path.join(root, "packages/runner/package.json")).resolve("tsx");

const fake = (id: string, stateDir: string, env: Record<string, string> = {}): AgentSpec => ({
  id,
  name: `Fake ${id}`,
  command: process.execPath,
  args: ["--import", tsx, path.join(root, "packages/runner/test/fake-agent.ts")],
  env: { FAKE_STATE_DIR: stateDir, ...env },
});

describe("factory API", () => {
  let handle: DbHandle;
  let factory: FactoryServices;
  let app: ReturnType<typeof createApp>;
  let repoPath: string;
  const auth = { authorization: "Bearer dev" };

  const call = async <T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> => {
    const res = await app.request(url, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  const until = async (fn: () => Promise<boolean>, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("condition not met in time");
  };

  beforeAll(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    const stateDir = await mkdtemp(path.join(tmpdir(), "api-fake-"));
    const config = loadConfig({
      AUTH_MODE: "dev",
      DEV_TOKEN: "dev",
      WORKFLOWS_DIR: path.join(root, "packages/core/test/fixtures/workflows"),
      WORKTREES_DIR: await mkdtemp(path.join(tmpdir(), "api-worktrees-")),
    });
    factory = await createFactoryServices({
      db: handle.db,
      config,
      agents: [
        fake("alpha", stateDir, { FAKE_LOAD: "1", FAKE_ON_CHECKS_FAILED: "fixed.txt" }),
        fake("beta", stateDir),
      ],
    });
    app = createApp({
      config,
      db: handle.db,
      authenticate: createDevAuthenticator("dev"),
      serverVersion: "0.1.0",
      factory,
    });

    repoPath = await mkdtemp(path.join(tmpdir(), "api-repo-"));
    await writeFile(path.join(repoPath, "README.md"), "# repo\n");
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    ]) {
      await exec("git", args, { cwd: repoPath });
    }
  });

  afterAll(async () => {
    await factory.runner.shutdown();
    await handle.close();
  });

  it("requires auth", async () => {
    expect((await app.request("/api/products")).status).toBe(401);
  });

  it("lists agents and workflows", async () => {
    expect((await call<{ id: string }[]>("GET", "/api/agents")).json.map((a) => a.id)).toEqual([
      "alpha",
      "beta",
    ]);
    const wfs = (await call<WorkflowDto[]>("GET", "/api/workflows")).json;
    expect(wfs.find((w) => w.type === "lite")?.steps.map((s) => s.id)).toEqual([
      "triage",
      "fix",
      "review",
    ]);
  });

  it("runs a card from creation to done over the API, with a thread message in between", async () => {
    const product = await call<ProductDto>("POST", "/api/products", { key: "app", name: "App" });
    expect(product).toMatchObject({ status: 201, json: { key: "APP" } });
    expect((await call("POST", "/api/products", { key: "APP", name: "Dup" })).status).toBe(400);
    const wrong = await call<{ detail?: string; error?: string }>(
      "POST",
      `/api/products/${product.json.id}/repos`,
      { name: "app", path: path.join(repoPath, "does-not-exist") },
    );
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.json)).toContain("folder not found");
    const repo = await call("POST", `/api/products/${product.json.id}/repos`, {
      name: "app",
      path: repoPath,
      checks: ["test -f fixed.txt"],
    });
    expect(repo.status).toBe(201);
    const repoId = (repo.json as RepoDto).id;
    const edited = await call<RepoDto>(
      "PATCH",
      `/api/products/${product.json.id}/repos/${repoId}`,
      { setup: ["git status"] },
    );
    expect(edited.json).toMatchObject({ setup: ["git status"], checks: ["test -f fixed.txt"] });
    expect(
      (
        await call("PATCH", `/api/products/${product.json.id}/repos/${repoId}`, {
          path: path.join(repoPath, "nope"),
        })
      ).status,
    ).toBe(400);

    const created = await call<CardDto>("POST", `/api/products/${product.json.id}/cards`, {
      type: "lite",
      title: "Crash on save",
    });
    expect(created.json).toMatchObject({
      key: "APP-1",
      state: "backlog",
      repoId: expect.any(String),
    });
    expect(
      (await call("POST", `/api/products/${product.json.id}/cards`, { type: "nope", title: "x" }))
        .status,
    ).toBe(400);
    const id = created.json.id;
    const card = async () => (await call<CardDetailDto>("GET", `/api/cards/${id}`)).json;

    expect((await call("POST", `/api/cards/${id}/decide`, { decision: "approved" })).status).toBe(
      400,
    );
    expect((await call("POST", `/api/cards/${id}/start`)).status).toBe(202);
    await until(async () => (await card()).card.state === "awaiting_gate");
    const triage = await card();
    expect(triage.card.step).toBe("triage");
    expect(triage.handovers).toHaveLength(1);
    const threadId = triage.threads[0]?.id as string;

    // Ask another agent something in the triage thread (consult while waiting at the gate).
    expect(
      (
        await call("POST", `/api/threads/${threadId}/messages`, {
          agentId: "beta",
          text: "Say: second opinion",
          mode: "consult",
        })
      ).status,
    ).toBe(202);
    await until(async () => {
      const t = (await call<ThreadDetailDto>("GET", `/api/threads/${threadId}`)).json;
      return t.events.some(
        (e) => e.kind === "agent_message" && e.payload.text === "second opinion",
      );
    });
    const thread = (await call<ThreadDetailDto>("GET", `/api/threads/${threadId}`)).json;
    const asker = thread.events.find((e) => e.kind === "user_message" && e.payload.to === "beta");
    expect(thread.names[asker?.actor ?? ""]).toBe("Developer");

    await call("POST", `/api/cards/${id}/decide`, { decision: "approved", comment: "go" });
    await until(
      async () =>
        (await card()).card.step === "review" && (await card()).card.state === "awaiting_gate",
    );
    await call("POST", `/api/cards/${id}/decide`, { decision: "approved" });
    await until(async () => (await card()).card.state === "done");
    const done = await card();
    expect(done.events.map((e) => e.kind)).toContain("checks_passed");
    expect(done.threads.map((t) => t.step)).toEqual(["triage", "fix", "review"]);
  }, 90_000);

  it("lists plugins and validates per-product config", async () => {
    const plugins = (await call<{ id: string }[]>("GET", "/api/plugins")).json.map((p) => p.id);
    expect(plugins).toEqual(["github", "gitlab", "mcp", "instructions", "webhook"]);
    const [product] = (await call<ProductDto[]>("GET", "/api/products")).json;
    const bad = await call<{ detail: string }>(
      "PUT",
      `/api/products/${product?.id}/plugins/github`,
      {
        enabled: true,
        config: { owner: "acme" },
      },
    );
    expect(bad.status).toBe(400);
    expect(bad.json.detail).toContain("repo");
    const ok = await call("PUT", `/api/products/${product?.id}/plugins/github`, {
      enabled: true,
      config: { owner: "acme", repo: "web" },
    });
    expect(ok.status).toBe(200);
    const configs = (
      await call<{ plugin: string; config: Record<string, unknown> }[]>(
        "GET",
        `/api/products/${product?.id}/plugins`,
      )
    ).json;
    expect(configs[0]).toMatchObject({
      plugin: "github",
      config: { owner: "acme", repo: "web", tokenEnv: "GITHUB_TOKEN" },
    });
    // Card detail carries links (none yet).
    const [card] = (await call<CardDto[]>("GET", `/api/products/${product?.id}/cards`)).json;
    expect((await call<CardDetailDto>("GET", `/api/cards/${card?.id}`)).json.links).toEqual([]);
    // Leave it disabled so later tests don't try to reach GitHub.
    await call("PUT", `/api/products/${product?.id}/plugins/github`, {
      enabled: false,
      config: { owner: "acme", repo: "web" },
    });
  });

  it("lets only admins manage products, repos and integrations", async () => {
    const member = createApp({
      config: loadConfig({ AUTH_MODE: "dev", DEV_TOKEN: "dev" }),
      db: handle.db,
      authenticate: async () => ({
        subject: "m1",
        username: "member",
        name: "Member",
        email: null,
        roles: ["factory-user"],
      }),
      serverVersion: "0.1.0",
      factory,
    });
    const req = (method: string, url: string, body?: unknown) =>
      member.request(url, {
        method,
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const [product] = (await call<ProductDto[]>("GET", "/api/products")).json;
    expect((await req("POST", "/api/products", { key: "NOPE", name: "x" })).status).toBe(403);
    expect(
      (await req("POST", `/api/products/${product?.id}/repos`, { name: "r", path: "/tmp" })).status,
    ).toBe(403);
    expect(
      (
        await req("PUT", `/api/products/${product?.id}/plugins/github`, {
          enabled: false,
          config: {},
        })
      ).status,
    ).toBe(403);
    // …but can read the board and see they aren't an admin.
    expect((await req("GET", "/api/products")).status).toBe(200);
    expect(await (await req("GET", "/api/me")).json()).toMatchObject({ isAdmin: false });
    expect(await (await call("GET", "/api/me")).json).toMatchObject({ isAdmin: true });
  });

  it("reports usage", async () => {
    const usage = (
      await call<{ total: { turns: number }; byAgent: { agentId: string }[] }>(
        "GET",
        "/api/usage?days=7",
      )
    ).json;
    expect(usage.total.turns).toBeGreaterThan(0);
    expect(usage.byAgent.map((a) => a.agentId)).toContain("alpha");
  });

  it("streams thread events over SSE", async () => {
    const [product] = (await call<ProductDto[]>("GET", "/api/products")).json;
    const created = await call<CardDto>("POST", `/api/products/${product?.id}/cards`, {
      type: "lite",
      title: "Stream me",
    });
    await call("POST", `/api/cards/${created.json.id}/start`);
    await until(
      async () =>
        (await call<CardDetailDto>("GET", `/api/cards/${created.json.id}`)).json.card.state ===
        "awaiting_gate",
    );
    const threadId = (await call<CardDetailDto>("GET", `/api/cards/${created.json.id}`)).json
      .threads[0]?.id;

    const controller = new AbortController();
    const res = await app.request(`/api/threads/${threadId}/stream`, {
      headers: auth,
      signal: controller.signal,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await call("POST", `/api/threads/${threadId}/messages`, {
      agentId: "alpha",
      text: "Say: streamed hello",
      mode: "consult",
    });
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes('"kind":"agent_message"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain('"type":"turn"');
    expect(text).toContain('"type":"chunk"');
    expect(text).toContain("streamed hello");
  }, 60_000);
});
