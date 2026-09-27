import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "ZeroTrustChat" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Copy invite" })).toBeVisible({ timeout: 60_000 });
}

async function assertServerZeroStorage(): Promise<void> {
  const health = await (await fetch("http://127.0.0.1:8787/health")).json();
  expect(health.messagesStored).toBe(0);
  expect(health.messagePlaintextReceived).toBe(0);
  expect(health.contactListsReceived).toBe(0);
  expect(health.privateKeysReceived).toBe(0);
}

test.describe("CPace short-code intro", () => {
  test("Alice hosts short code; Bob joins; P2P chat; few server contacts", async ({ browser }) => {
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    await alice.goto("http://127.0.0.1:5173");
    await bob.goto("http://127.0.0.1:5173");
    await waitReady(alice);
    await waitReady(bob);

    await alice.getByRole("button", { name: "Create short code" }).click();
    const codeInput = alice.getByLabel("Hosted short code");
    await expect(codeInput).toHaveValue(/^[1-9][0-9]{0,5}-[a-z]+-[a-z]+$/, { timeout: 15_000 });
    const code = await codeInput.inputValue();

    await bob.getByLabel("Join short code").fill(code);
    await bob.getByRole("button", { name: "Join short code" }).click();

    await expect(alice.getByText("P2P: connected").first()).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("P2P: connected").first()).toBeVisible({ timeout: 90_000 });

    const secret = `short-code-secret-${Date.now()}`;
    await alice.getByLabel("Message").fill(secret);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(bob.getByText(secret)).toBeVisible({ timeout: 30_000 });

    // Essential contacts should stay small after reset-at-intro (shown on dashboard)
    const essential = alice.locator(".stat").filter({ hasText: "Server contacts (essential)" }).locator(".v");
    await expect
      .poll(async () => Number(await essential.textContent()), { timeout: 10_000 })
      .toBeLessThanOrEqual(12);

    await assertServerZeroStorage();

    await aliceCtx.close();
    await bobCtx.close();
  });
});
