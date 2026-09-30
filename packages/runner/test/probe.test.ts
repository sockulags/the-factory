import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/agents.js";
import { probeAgent } from "../src/probe.js";
import { renderMarkdown } from "../src/report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function fakeAgent(flags: Record<string, string>): Promise<AgentSpec> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "fake-agent-"));
  return {
    id: "fake",
    name: "Fake agent",
    command: process.execPath,
    args: ["--import", tsxLoader, path.join(here, "fake-agent.ts")],
    env: { FAKE_STATE_DIR: stateDir, ...flags },
  };
}

const probe = (spec: AgentSpec) => probeAgent(spec, { turnTimeoutMs: 20_000 });

describe("probeAgent", () => {
  it("passes every check for a well-behaved agent with session/load", async () => {
    const report = await probe(await fakeAgent({ FAKE_LOAD: "1", FAKE_USAGE: "1" }));
    const statuses = Object.fromEntries(
      Object.entries(report.checks).map(([k, v]) => [k, v.status]),
    );
    expect(statuses).toEqual({
      start: "pass",
      prompt: "pass",
      usage: "pass",
      write: "pass",
      readOnly: "pass",
      cancel: "pass",
      resume: "pass",
    });
    expect(report.checks.write.detail).toContain("via client fs");
    expect(report.checks.resume.detail).toMatch(/session\/load \(replayed \d+ update/);
    expect(report.checks.usage.detail).toContain("cost 0.01 USD");
    expect(report.info).toMatchObject({
      loadSession: true,
      modes: ["default", "plan"],
      authMethods: ["cli-login"],
    });
  }, 60_000);

  it("uses session/resume when load isn't offered, and reports missing usage", async () => {
    const report = await probe(await fakeAgent({ FAKE_RESUME: "1" }));
    expect(report.checks.resume).toMatchObject({ status: "pass", detail: "session/resume" });
    expect(report.checks.usage.status).toBe("unsupported");
  }, 60_000);

  it("reports resume as unsupported when neither load nor resume exists", async () => {
    const report = await probe(await fakeAgent({}));
    expect(report.checks.resume.status).toBe("unsupported");
  }, 60_000);

  it("catches an agent that bypasses read-only by writing files itself", async () => {
    const report = await probe(
      await fakeAgent({ FAKE_DIRECT: "1", FAKE_NO_PERMISSION: "1", FAKE_LOAD: "1" }),
    );
    expect(report.checks.write).toMatchObject({ status: "pass" });
    expect(report.checks.write.detail).toContain("agent's own tools");
    expect(report.checks.readOnly.status).toBe("fail");
    expect(report.checks.readOnly.detail).toContain("created anyway");
  }, 60_000);

  it("stops with a login hint when the agent is not signed in", async () => {
    const spec = { ...(await fakeAgent({ FAKE_AUTH: "1" })), loginHint: "Run `fake login`." };
    const report = await probe(spec);
    expect(report.checks.start.status).toBe("pass");
    expect(report.checks.prompt).toMatchObject({ status: "error" });
    expect(report.checks.prompt.detail).toContain("Run `fake login`");
  }, 60_000);

  it("reports an agent that cannot be started", async () => {
    const report = await probe({
      id: "nope",
      name: "Missing",
      command: "definitely-not-a-command-xyz",
      args: [],
    });
    expect(report.checks.start.status).toBe("error");
    expect(report.checks.prompt.status).toBe("skipped");
  });

  it("renders a markdown matrix", async () => {
    const report = await probe(await fakeAgent({ FAKE_LOAD: "1" }));
    const md = renderMarkdown([report], { host: "test", date: "2026-09-30" });
    expect(md).toContain("| Check | fake |");
    expect(md).toContain("| Resume after restart | ✅ |");
  }, 60_000);
});
