// Full stack: built server (OIDC mode) + mock Keycloak + the real Electron app.
// Requires `pnpm build` first. On Linux CI run under xvfb-run.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockOidc, startMockOidc } from "../support/mock-oidc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "../..");
const serverEntry = path.resolve(desktopDir, "../server/dist/index.js");
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const SERVER_PORT = 8791;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

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

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
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

describe("desktop sign-in (e2e)", () => {
  let idp: MockOidc;
  let server: ChildProcess;
  let userDataDir: string;

  beforeAll(async () => {
    idp = await startMockOidc({
      clientId: "factory-desktop",
      user: {
        sub: "kc-42",
        preferred_username: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "factory-e2e-server-"));
    server = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        HOST: "127.0.0.1",
        PUBLIC_URL: SERVER_URL,
        DATABASE_URL: `pglite:${dataDir}/db`,
        AUTH_MODE: "oidc",
        OIDC_ISSUER: idp.issuer,
        OIDC_CLIENT_ID: idp.clientId,
        UPDATES_DIR: `${dataDir}/updates`,
      },
      stdio: "inherit",
    });
    await waitForHealth(SERVER_URL);
    userDataDir = await mkdtemp(path.join(tmpdir(), "factory-e2e-app-"));
  });

  afterAll(async () => {
    server?.kill();
    await idp?.close();
  });

  it("connects, signs in through the IdP and shows the user", async () => {
    const { app, page } = await launchApp(userDataDir);
    try {
      await page.getByLabel("Server address").fill(SERVER_URL);
      await page.getByRole("button", { name: "Connect" }).click();
      await page.getByRole("button", { name: "Sign in with company account" }).click();
      await expect
        .poll(() => page.getByTestId("connected-as").textContent(), { timeout: 15_000 })
        .toContain("Ada Lovelace");
      expect(await page.textContent("footer")).toContain("server v0.1.0");
      await page.screenshot({ path: path.join(desktopDir, "test-results", "signed-in.png") });
      expect(idp.issued.some((i) => i.grant === "authorization_code")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("remembers the server after a restart", async () => {
    const { app, page } = await launchApp(userDataDir);
    try {
      // With an OS keystore the session survives too; without one (bare Linux CI) only the server does.
      await expect
        .poll(
          async () =>
            (await page.getByTestId("connected-as").count()) +
            (await page.getByRole("button", { name: /Sign in/ }).count()),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
