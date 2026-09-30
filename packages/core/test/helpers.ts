import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentSpec } from "@factory/runner";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.resolve(here, "../../runner/test/fake-agent.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

export function fakeAgent(
  id: string,
  stateDir: string,
  flags: Record<string, string> = {},
): AgentSpec {
  return {
    id,
    name: `Fake ${id}`,
    command: process.execPath,
    args: ["--import", tsxLoader, fakeAgentPath],
    env: { FAKE_STATE_DIR: stateDir, ...flags },
  };
}

/** Everything the fake agent received as user prompts in a session. */
export async function received(stateDir: string, sessionId: string): Promise<string[]> {
  const state = JSON.parse(await readFile(path.join(stateDir, `${sessionId}.json`), "utf8")) as {
    history: { role: string; text: string }[];
  };
  return state.history.filter((h) => h.role === "user").map((h) => h.text);
}

export async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-thread-"));
  await writeFile(path.join(dir, "README.md"), "# test\n");
  await git(dir, "init", "-q");
  await git(dir, "add", ".");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}
