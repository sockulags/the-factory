import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type DbHandle, openDb } from "@factory/db";
import { LocalRunner } from "@factory/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Board, type Card } from "../src/board.js";
import { builtinPlugins, PluginError, PluginHost } from "../src/plugins/index.js";
import { ThreadService } from "../src/thread-service.js";
import { loadWorkflows } from "../src/workflow/definition.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { fakeAgent, git, gitRepo } from "./helpers.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** Plays GitHub/GitLab APIs: first create succeeds, later creates say "already exists". */
function fakeForge() {
  const calls: Call[] = [];
  let created = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    if (url.includes("/pulls") && method === "POST") {
      return created++ === 0
        ? Response.json(
            { number: 7, html_url: "https://github.test/acme/web/pull/7", title: "t" },
            { status: 201 },
          )
        : Response.json({ message: "A pull request already exists" }, { status: 422 });
    }
    if (url.includes("/pulls?head="))
      return Response.json([
        { number: 7, html_url: "https://github.test/acme/web/pull/7", title: "t" },
      ]);
    if (url.includes("/merge_requests") && method === "POST") {
      return Response.json(
        { iid: 3, web_url: "https://gitlab.test/g/web/-/merge_requests/3", title: "t" },
        { status: 201 },
      );
    }
    if (url.includes("hooks.slack")) return new Response("ok");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("plugins", () => {
  let handle: DbHandle;
  let runner: LocalRunner;
  let board: Board;
  let host: PluginHost;
  let engine: WorkflowEngine;
  let forge: ReturnType<typeof fakeForge>;
  let productId: string;
  let repoId: string;
  let remote: string;
  const env = {
    GITHUB_TOKEN: "ghp_test",
    GITLAB_TOKEN: "glpat",
    SLACK_URL: "https://hooks.slack.test/x",
    JIRA_AUTH: "Basic abc",
  };

  beforeAll(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    runner = new LocalRunner([
      fakeAgent("alpha", await mkdtemp(path.join(tmpdir(), "fake-")), { FAKE_LOAD: "1" }),
    ]);
    board = new Board(handle.db);
    forge = fakeForge();
    host = new PluginHost(handle.db, builtinPlugins({ fetch: forge.fetchImpl }), env);
    const threads = new ThreadService({
      db: handle.db,
      runner,
      turnTimeoutMs: 20_000,
      mcpServersFor: async (t) =>
        t.cardId ? host.mcpServersFor((await board.getCard(t.cardId))?.productId ?? "") : [],
    });
    engine = new WorkflowEngine({
      board,
      threads,
      runner,
      workflows: await loadWorkflows(path.join(here, "fixtures/workflows"), ["alpha", "beta"]),
      worktreesDir: await mkdtemp(path.join(tmpdir(), "wt-")),
      resolveHook: (card, name) => host.resolveHook(card, name),
      instructionsFor: (card) => host.instructionsFor(card.productId),
    });
    const repoPath = await gitRepo();
    remote = await mkdtemp(path.join(tmpdir(), "remote-"));
    await exec("git", ["init", "-q", "--bare", remote]);
    productId = (await board.createProduct({ key: "PLG", name: "Plugins" })).id;
    repoId = (
      await board.addRepo({
        productId,
        name: "web",
        path: repoPath,
        defaultBranch: await git(repoPath, "branch", "--show-current"),
      })
    ).id;
  });
  afterAll(async () => {
    await runner.shutdown();
    await handle.close();
  });

  it("validates config per plugin", async () => {
    await expect(
      host.configure(productId, "github", { enabled: true, config: { owner: "acme" } }),
    ).rejects.toThrow(/repo/);
    await expect(
      host.configure(productId, "nope", { enabled: true, config: {} }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it("opens a GitHub PR when the docs step is approved, pushing the branch, and reuses it on re-run", async () => {
    await host.configure(productId, "github", {
      enabled: true,
      config: { owner: "acme", repo: "web", remote },
    });
    await host.configure(productId, "instructions", {
      enabled: true,
      config: { text: "Always mention PLG keys." },
    });
    await host.configure(productId, "mcp", {
      enabled: true,
      config: {
        servers: [
          {
            type: "http",
            name: "jira",
            url: "https://mcp.example.com",
            headers: { Authorization: "JIRA_AUTH" },
          },
        ],
      },
    });

    const card = await board.createCard({
      productId,
      repoId,
      type: "docs-lite",
      title: "Invoice PDF",
    });
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    await engine.decide(card.id, "approved");
    await engine.whenIdle(card.id);
    const done = (await board.getCard(card.id)) as Card;
    expect(done.state).toBe("done");

    // Branch pushed with both step commits.
    const log = await git(remote, "log", "--format=%s", done.branch as string);
    expect(log.split("\n")).toHaveLength(3); // 2 step commits + init
    // PR opened with a useful body.
    const create = forge.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/repos/acme/web/pulls"),
    );
    expect(create?.headers.authorization).toBe("Bearer ghp_test");
    expect(create?.body).toMatchObject({
      title: "PLG-1: Invoice PDF",
      head: done.branch,
      draft: false,
    });
    expect(String(create?.body?.body)).toContain("### Steps");
    expect(await board.links(card.id)).toEqual([
      expect.objectContaining({
        plugin: "github",
        kind: "pull_request",
        ref: "7",
        url: "https://github.test/acme/web/pull/7",
      }),
    ]);
    const ran = (await board.events(card.id)).find((e) => e.kind === "hook_ran");
    expect(ran?.payload).toMatchObject({ hook: "vcs.open_pr", result: { pullRequest: 7 } });

    // Instructions reached the agent; MCP servers resolve env names.
    const thread = await board.stepThread(card.id, "write");
    const [first] = await new ThreadService({ db: handle.db, runner }).events(thread?.id as string);
    expect((first?.payload as { text: string }).text).toContain(
      "## Product instructions\nAlways mention PLG keys.",
    );
    expect(await host.mcpServersFor(productId)).toEqual([
      {
        type: "http",
        name: "jira",
        url: "https://mcp.example.com",
        headers: [{ name: "Authorization", value: "Basic abc" }],
      },
    ]);

    // The hook again (e.g. after a re-run): 422 → finds the open PR, no duplicate link.
    const hook = await host.resolveHook(done, "vcs.open_pr");
    const repo = await board.getRepo(repoId);
    const docs = (await loadWorkflows(path.join(here, "fixtures/workflows"))).get("docs-lite");
    await hook?.({ card: done, step: docs?.steps[1] as never, repo, board, runner });
    expect(await board.links(card.id)).toHaveLength(1);
  }, 60_000);

  it("opens a GitLab MR and posts a webhook", async () => {
    await host.configure(productId, "github", {
      enabled: false,
      config: { owner: "acme", repo: "web", remote },
    });
    await host.configure(productId, "gitlab", {
      enabled: true,
      config: { project: "g/web", baseUrl: "https://gitlab.test", remote },
    });
    await host.configure(productId, "webhook", { enabled: true, config: { urlEnv: "SLACK_URL" } });

    const card = await board.createCard({ productId, repoId, type: "docs-lite", title: "Search" });
    await engine.start(card.id);
    await engine.whenIdle(card.id);
    await engine.decide(card.id, "approved");
    await engine.whenIdle(card.id);
    const mr = forge.calls.find(
      (c) => c.url === "https://gitlab.test/api/v4/projects/g%2Fweb/merge_requests",
    );
    expect(mr?.headers["private-token"]).toBe("glpat");
    expect(mr?.body).toMatchObject({ target_branch: expect.any(String), title: "PLG-2: Search" });
    expect((await board.links(card.id))[0]).toMatchObject({ plugin: "gitlab", ref: "3" });

    const notify = await host.resolveHook((await board.getCard(card.id)) as Card, "notify.webhook");
    const result = await notify?.({
      card: (await board.getCard(card.id)) as Card,
      step: { id: "docs", name: "Docs" } as never,
      repo: null,
      board,
      runner,
    });
    expect(result).toEqual({ delivered: true });
    expect(forge.calls.at(-1)?.body?.text).toContain("PLG-2");
  }, 60_000);

  it("reports a missing secret clearly", async () => {
    const bare = new PluginHost(handle.db, builtinPlugins({ fetch: forge.fetchImpl }), {});
    const card = (await board.findCardByKey("PLG-1")) as Card;
    const hook = await bare.resolveHook(card, "gitlab.vcs.open_pr");
    await expect(
      hook?.({ card, step: {} as never, repo: await board.getRepo(repoId), board, runner }),
    ).rejects.toThrow(/GITLAB_TOKEN is not set/);
  });
});
