import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DbHandle, openDb } from "@factory/db";
import { LocalRunner } from "@factory/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentMessagePayload, ThreadEvent } from "../src/events.js";
import { type LiveEvent, type Thread, ThreadService } from "../src/thread-service.js";
import { fakeAgent, git, gitRepo, received } from "./helpers.js";

const payload = (e: ThreadEvent) => e.payload as AgentMessagePayload;

describe("ThreadService", () => {
  let handle: DbHandle;
  let stateDir: string;
  let repo: string;
  let runner: LocalRunner;
  let service: ThreadService;
  let thread: Thread;
  let headBefore: string;

  const agents = () => [
    fakeAgent("alpha", stateDir, { FAKE_LOAD: "1" }), // supports session/load
    fakeAgent("beta", stateDir), // no load/resume: must be rehydrated after restarts
  ];
  const makeService = (r: LocalRunner) =>
    new ThreadService({
      db: handle.db,
      runner: r,
      turnTimeoutMs: 20_000,
      names: { local: "Lucas" },
    });

  beforeAll(async () => {
    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    stateDir = await mkdtemp(path.join(tmpdir(), "fake-state-"));
    repo = await gitRepo();
    headBefore = await git(repo, "rev-parse", "HEAD");
    runner = new LocalRunner(agents());
    service = makeService(runner);
    thread = await service.createThread({ title: "Fix login bug", cwd: repo });
  });

  afterAll(async () => {
    await runner.shutdown();
    await handle.close();
  });

  it("sends the first message as-is", async () => {
    const reply = await service.send({
      threadId: thread.id,
      agentId: "alpha",
      text: "Say: hello from alpha",
    });
    expect(payload(reply).text).toBe("hello from alpha");
    expect(payload(reply).sessionOrigin).toBe("new");
    expect(payload(reply).sent).toBe("Say: hello from alpha");
  });

  it("switching to another agent gives it a recap of the thread", async () => {
    const reply = await service.send({
      threadId: thread.id,
      agentId: "beta",
      text: "Say: beta here",
    });
    expect(payload(reply).text).toBe("beta here");
    const sent = payload(reply).sent;
    expect(sent).toContain("<factory-context>");
    expect(sent).toContain("joining an ongoing thread");
    expect(sent).toContain('Lucas (to alpha): "Say: hello from alpha"');
    expect(sent).toContain('alpha replied: "hello from alpha"');
    expect(sent.endsWith("\n\nSay: beta here")).toBe(true);
  });

  it("switching back sends only what the agent hasn't seen", async () => {
    const reply = await service.send({
      threadId: thread.id,
      agentId: "alpha",
      text: "Say: back again",
    });
    const sent = payload(reply).sent;
    expect(payload(reply).sessionOrigin).toBe("live");
    expect(sent).toContain("Since your last turn:");
    expect(sent).toContain('Lucas (to beta): "Say: beta here"');
    expect(sent).toContain('beta replied: "beta here"');
    expect(sent).not.toContain("hello from alpha"); // its own earlier turn is already in its session

    const nothingNew = await service.send({
      threadId: thread.id,
      agentId: "alpha",
      text: "Say: quiet",
    });
    expect(payload(nothingNew).sent).toBe("Say: quiet");
  });

  it("snapshots file changes without touching HEAD or the index, and tells the other agent", async () => {
    const write = await service.send({
      threadId: thread.id,
      agentId: "alpha",
      text: "Create a file named notes.md in the current directory containing exactly the text: hello",
    });
    expect(payload(write).changes).toEqual([{ path: "notes.md", added: 1, removed: 0 }]);
    expect(existsSync(path.join(repo, "notes.md"))).toBe(true);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(repo, "status", "--porcelain")).toBe("?? notes.md");

    const reply = await service.send({ threadId: thread.id, agentId: "beta", text: "Say: noted" });
    const sent = payload(reply).sent;
    expect(sent).toContain("alpha replied [changed notes.md]");
    expect(sent).toMatch(/1 file changed in the worktree since your last turn:[\s\S]*notes\.md/);
    expect(sent).toMatch(/git diff [0-9a-f]{40}/);
  });

  it("consulting an agent is read-only and does not change the driver", async () => {
    await service.send({ threadId: thread.id, agentId: "alpha", text: "Say: I drive" });
    const reply = await service.send({
      threadId: thread.id,
      agentId: "beta",
      mode: "consult",
      text: "Create a file named sneaky.txt in the current directory containing exactly the text: nope",
    });
    expect(existsSync(path.join(repo, "sneaky.txt"))).toBe(false);
    expect(payload(reply).sent).toContain("read-only mode");
    expect(payload(reply).text).toMatch(/Permission denied|Could not write/);
    expect((await service.getThread(thread.id))?.driverAgentId).toBe("alpha");
  });

  it("after a runner restart, reloads sessions that support it and rehydrates the rest", async () => {
    await runner.shutdown();
    runner = new LocalRunner(agents());
    service = makeService(runner);

    const alpha = await service.send({
      threadId: thread.id,
      agentId: "alpha",
      text: "Say: alpha after restart",
    });
    expect(payload(alpha).sessionOrigin).toBe("loaded");
    expect(payload(alpha).sent).toContain("Since your last turn:");
    expect(payload(alpha).sent).not.toContain("joining an ongoing thread");

    const beta = await service.send({
      threadId: thread.id,
      agentId: "beta",
      text: "Say: beta after restart",
    });
    expect(payload(beta).sessionOrigin).toBe("new");
    expect(payload(beta).sent).toContain("joining an ongoing thread");
    expect(payload(beta).sent).toContain("hello from alpha");
    expect(payload(beta).sent).toMatch(
      /changed in the worktree since the thread started[\s\S]*notes\.md/,
    );

    // The agent really received it in its (new) session.
    const [session] = (await service.sessions(thread.id)).filter((s) => s.agentId === "beta");
    const got = await received(stateDir, session?.acpSessionId ?? "");
    expect(got.at(-1)).toBe(payload(beta).sent);
  });

  it("streams live events and serializes concurrent sends", async () => {
    const seen: LiveEvent["type"][] = [];
    const unsubscribe = service.subscribe(thread.id, (e) => seen.push(e.type));
    const [a, b] = await Promise.all([
      service.send({ threadId: thread.id, agentId: "alpha", text: "Say: one" }),
      service.send({ threadId: thread.id, agentId: "beta", text: "Say: two" }),
    ]);
    unsubscribe();
    expect(payload(a).text).toBe("one");
    expect(payload(b).text).toBe("two");
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(seen).toContain("update");
    expect(seen.filter((t) => t === "turn")).toHaveLength(4);

    const events = await service.events(thread.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("records an error and keeps the cursor when a turn fails", async () => {
    await expect(
      service.send({ threadId: thread.id, agentId: "ghost", text: "hi" }),
    ).rejects.toThrow(/unknown agent/);
    const last = (await service.events(thread.id)).at(-1);
    expect(last?.kind).toBe("error");
  });
});
