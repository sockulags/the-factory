import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/agents.js";
import { createRunnerHandler, RemoteRunner } from "../src/remote.js";
import { LocalRunner } from "../src/runner.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");

describe("runner protocol", () => {
  let local: LocalRunner;
  let remote: RemoteRunner;
  let repo: string;
  const agents: AgentSpec[] = [];

  beforeAll(async () => {
    const state = await mkdtemp(path.join(tmpdir(), "remote-fake-"));
    agents.push({
      id: "alpha",
      name: "Fake alpha",
      command: process.execPath,
      args: ["--import", tsx, path.join(here, "fake-agent.ts")],
      env: { FAKE_STATE_DIR: state, FAKE_USAGE: "1" },
    });
    local = new LocalRunner(agents);
    const handler = createRunnerHandler(local, { token: "s3cret", agents });
    const viaHandler = (async (input: string | URL, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof fetch;
    remote = new RemoteRunner("http://runner.test/", "s3cret", viaHandler);

    repo = await mkdtemp(path.join(tmpdir(), "remote-repo-"));
    await writeFile(path.join(repo, "a.txt"), "a\n");
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"],
    ]) {
      await exec("git", args, { cwd: repo });
    }
  });
  afterAll(() => local.shutdown());

  it("lists agents and rejects bad tokens", async () => {
    expect(await remote.agents()).toEqual([{ id: "alpha", name: "Fake alpha" }]);
    const handler = createRunnerHandler(local, { token: "s3cret", agents });
    const res = await handler(
      new Request("http://runner.test/rpc/exec", {
        method: "POST",
        body: "[]",
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("runs a turn remotely, streaming updates, then snapshots and diffs the worktree", async () => {
    const { sessionId, origin } = await remote.openSession({
      agentId: "alpha",
      cwd: repo,
      mode: "write",
    });
    expect(origin).toBe("new");
    const before = await remote.checkpoint(repo, "refs/factory/test/before", "before");
    const updates: SessionUpdate[] = [];
    const turn = await remote.prompt({
      agentId: "alpha",
      sessionId,
      mode: "write",
      text: "Create a file named b.txt in the current directory containing exactly the text: hello",
      onUpdate: (u) => updates.push(u),
    });
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.writes).toEqual(["b.txt"]);
    expect(turn.usage).toMatchObject({ inputTokens: 100 });
    expect(updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);

    const after = await remote.checkpoint(repo, "refs/factory/test/after", "after");
    const diff = await remote.diff(repo, before as string, after as string);
    expect(diff.files).toEqual([{ path: "b.txt", added: 1, removed: 0 }]);
    expect((await remote.exec("cat b.txt", repo)).output).toBe("hello");
    expect(await remote.commitAll(repo, "remote commit")).toMatch(/^[0-9a-f]{40}$/);
    // Omitted optional arguments (sent as null) still get their defaults.
    expect((await remote.patch(repo, before as string, after as string)).patch).toContain("+hello");
    expect(await remote.remoteUrl(repo)).toBeNull();
  }, 30_000);

  it("propagates errors with their message", async () => {
    await expect(
      remote.openSession({ agentId: "ghost", cwd: repo, mode: "write" }),
    ).rejects.toThrow(/unknown agent "ghost"/);
    await expect(
      remote.prompt({ agentId: "alpha", sessionId: "no-such-session", mode: "write", text: "hi" }),
    ).rejects.toThrow(/unknown session/);
  });
});
