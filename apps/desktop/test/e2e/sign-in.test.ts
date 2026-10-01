import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desktopDir, launchApp, type Stack, signIn, startStack, tempDir } from "./harness.js";

describe("desktop sign-in (e2e)", () => {
  let stack: Stack;
  let userDataDir: string;

  beforeAll(async () => {
    stack = await startStack(8791);
    userDataDir = await tempDir("factory-e2e-app-");
  });
  afterAll(() => stack?.stop());

  it("connects, signs in through the IdP and shows the user", async () => {
    const { app, page } = await launchApp(userDataDir);
    try {
      await signIn(page, stack.serverUrl);
      expect(await page.getByTestId("connected-as").textContent()).toContain("Ada Lovelace");
      await page.screenshot({ path: path.join(desktopDir, "test-results", "signed-in.png") });
      expect(stack.idp.issued.some((i) => i.grant === "authorization_code")).toBe(true);
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
