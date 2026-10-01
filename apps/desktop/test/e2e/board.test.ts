import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desktopDir, launchApp, type Stack, signIn, startStack, tempDir } from "./harness.js";

describe("board (e2e)", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack(8792);
  });
  afterAll(() => stack?.stop());

  it("sets up a product, runs a card through its workflow and talks to another agent", async () => {
    const { app, page } = await launchApp(await tempDir("factory-e2e-board-"));
    const shots = (name: string) =>
      page.screenshot({ path: path.join(desktopDir, "test-results", `${name}.png`) });
    try {
      await page.setViewportSize({ width: 1400, height: 900 });
      await signIn(page, stack.serverUrl);

      // First run: no products yet → setup.
      await page.getByLabel("Key").fill("WEB");
      await page.getByLabel("Name", { exact: true }).fill("Web app");
      await page.getByRole("button", { name: "Create product" }).click();
      await page.getByRole("button", { name: "Products & repos" }).click();
      await page.getByLabel("Path on the server").fill(stack.repoPath);
      await page.getByLabel("Checks (one per line)").fill("test -f fixed.txt");
      await page.getByRole("button", { name: "Add repo" }).click();
      await page.getByText("checks: test -f fixed.txt").waitFor();
      await page.getByRole("button", { name: "Back to the board" }).click();

      // New card → backlog → start.
      await page.getByRole("button", { name: "New card" }).click();
      await page.getByLabel("Type").selectOption("lite");
      await page.getByLabel("Title").fill("Save button is greyed out");
      await page.getByLabel("Description").fill("Happens after editing a draft.");
      await page.getByRole("button", { name: "Create in backlog" }).click();
      const panel = page.getByRole("complementary", { name: "Card WEB-1" });
      await panel.getByRole("button", { name: "Start" }).click();

      // Triage runs, then waits at the human gate.
      await panel.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30_000 });
      await expect
        .poll(() => panel.getByText("triaged WEB-1 Save button is greyed out").count())
        .toBeGreaterThan(0);

      // Ask the other agent in the same thread (consult).
      await panel.getByLabel("Agent").selectOption("beta");
      await panel.getByLabel("Message").fill("Say: second opinion from beta");
      await panel.getByRole("button", { name: "Send" }).click();
      await expect
        .poll(() => panel.getByText("second opinion from beta", { exact: true }).count(), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      await shots("board-triage");

      // Approve → fix (checks fail once, agent fixes) → review gate.
      await panel.getByRole("button", { name: "Approve" }).click();
      await expect
        .poll(
          async () =>
            (await panel
              .getByRole("list", { name: "Workflow steps" })
              .locator("li.current")
              .textContent()) ?? "",
          {
            timeout: 40_000,
          },
        )
        .toBe("Review");
      await panel.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30_000 });

      // The board reflects it live.
      await expect.poll(() => page.locator('[data-column="needs-you"] .card').count()).toBe(1);

      // Handovers were written for every step so far.
      await panel.getByRole("tab", { name: /Handovers/ }).click();
      await expect.poll(() => panel.locator(".handover").count()).toBeGreaterThanOrEqual(3);

      await panel.getByRole("button", { name: "Approve" }).click();
      await expect
        .poll(() => page.locator('[data-column="done"] .card').count(), { timeout: 30_000 })
        .toBe(1);
      await shots("board-done");

      // A card whose workflow ends in a docs step: review the proposed doc diff.
      await page.getByRole("button", { name: "Close panel" }).click();
      await page.getByRole("button", { name: "New card" }).click();
      await page.getByLabel("Type").selectOption("docs-lite");
      await page.getByLabel("Title").fill("CSV export");
      await page.getByRole("button", { name: "Create in backlog" }).click();
      const docsPanel = page.getByRole("complementary", { name: "Card WEB-2" });
      await docsPanel.getByRole("button", { name: "Start" }).click();
      await docsPanel
        .getByRole("button", { name: "Approve & commit docs" })
        .waitFor({ timeout: 30_000 });
      await docsPanel.getByRole("tab", { name: /Doc changes/ }).click();
      await expect
        .poll(async () =>
          (await docsPanel.locator(".diff .add").allTextContents()).map((t) => t.trim()),
        )
        .toContain("+# Guide for CSV export");
      await shots("docs-review");
      await docsPanel.getByRole("button", { name: "Approve & commit docs" }).click();
      await expect
        .poll(() => docsPanel.getByText("Approved and committed").count(), { timeout: 20_000 })
        .toBe(1);

      // Usage: every agent turn so far is counted.
      await page.getByRole("button", { name: "Usage" }).click();
      const usage = page.getByRole("region", { name: "Usage" });
      await usage.getByText("Agent turns").waitFor();
      const turns = Number(await usage.locator(".tile strong").first().textContent());
      expect(turns).toBeGreaterThan(5);
      await shots("usage");
    } finally {
      await app.close();
    }
  }, 180_000);
});
