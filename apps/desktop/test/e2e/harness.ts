// Full stack for e2e tests: mock Keycloak + the built server (OIDC mode, fake ACP agents,
// test workflows) + the real Electron app. Requires `pnpm build`; on Linux run under xvfb-run.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { type MockOidc, startMockOidc } from "../support/mock-oidc.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopDir = path.resolve(here, "../..");
const root = path.resolve(desktopDir, "../..");
const serverEntry = path.join(root, "apps/server/dist/index.js");
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const tsx = createRequire(path.join(root, "packages/runner/package.json")).resolve("tsx");

export interface Stack {
  idp: MockOidc;
  serverUrl: string;
  /** A git repo the server can create card worktrees from. */
  repoPath: string;
  stop(): Promise<void>;
}

export async function startStack(port: number): Promise<Stack> {
  const idp = await startMockOidc({
    clientId: "factory-desktop",
    user: {
      sub: "kc-42",
      preferred_username: "ada",
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "factory-e2e-server-"));
  const agentsFile = path.join(dataDir, "agents.json");
  const fake = (id: string, env: Record<string, string>) => ({
    id,
    name: `Agent ${id}`,
    command: process.execPath,
    args: ["--import", tsx, path.join(root, "packages/runner/test/fake-agent.ts")],
    env: { FAKE_STATE_DIR: path.join(dataDir, "fake-state"), ...env },
  });
  await writeFile(
    agentsFile,
    JSON.stringify([
      fake("alpha", { FAKE_LOAD: "1", FAKE_ON_CHECKS_FAILED: "fixed.txt" }),
      fake("beta", {}),
    ]),
  );

  const repoPath = await mkdtemp(path.join(tmpdir(), "factory-e2e-repo-"));
  await writeFile(path.join(repoPath, "README.md"), "# e2e\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
  ]) {
    await exec("git", args, { cwd: repoPath });
  }

  const serverUrl = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: serverUrl,
      DATABASE_URL: `pglite:${dataDir}/db`,
      AUTH_MODE: "oidc",
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      UPDATES_DIR: `${dataDir}/updates`,
      WORKFLOWS_DIR: path.join(root, "packages/core/test/fixtures/workflows"),
      WORKTREES_DIR: path.join(dataDir, "worktrees"),
      AGENTS_CONFIG: agentsFile,
    },
    stdio: "inherit",
  });
  await waitForHealth(serverUrl);
  return {
    idp,
    serverUrl,
    repoPath,
    async stop() {
      server.kill();
      await idp.close();
    },
  };
}

async function waitForHealth(url: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy");
}

export async function launchApp(
  userDataDir: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir, "--no-sandbox"],
    env: { ...process.env, FACTORY_USER_DATA_DIR: userDataDir },
  });
  // Stand in for the system browser: follow the IdP redirect back to the loopback server.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url, { redirect: "follow" });
    };
  });
  const page = await app.firstWindow();
  return { app, page };
}

/** Connects to the server and signs in through the (mock) IdP. */
export async function signIn(page: Page, serverUrl: string): Promise<void> {
  await page.getByLabel("Server address").fill(serverUrl);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Sign in with company account" }).click();
  await page.getByTestId("connected-as").waitFor({ timeout: 15_000 });
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
