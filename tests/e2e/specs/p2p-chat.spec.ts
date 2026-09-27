import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function readInvite(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: "ZeroTrustChat" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Copy invite" })).toBeVisible({ timeout: 60_000 });
  const area = page.locator("textarea").first();
  await expect(area).not.toHaveValue("");
  return area.inputValue();
}

async function addPeer(page: Page, invite: string): Promise<void> {
  await page.getByLabel("Paste invitation code").fill(invite);
  await page.getByRole("button", { name: "Add & connect" }).click();
}

async function assertServerZeroStorage(): Promise<void> {
  const health = await (await fetch("http://127.0.0.1:8787/health")).json();
  expect(health.messagesStored).toBe(0);
  expect(health.messagePlaintextReceived).toBe(0);
  expect(health.contactListsReceived).toBe(0);
  expect(health.privateKeysReceived).toBe(0);
}

async function connectTwo(alice: Page, bob: Page): Promise<{ aliceInvite: string; bobInvite: string }> {
  const aliceInvite = await readInvite(alice);
  const bobInvite = await readInvite(bob);
  await addPeer(alice, bobInvite);
  await bob.waitForTimeout(800);
  await addPeer(bob, aliceInvite);
  await expect(alice.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
  await expect(bob.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
  return { aliceInvite, bobInvite };
}

test.describe("P2P messaging privacy", () => {
  test("Alice and Bob chat over P2P; server stores zero messages", async ({ browser }) => {
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    await alice.goto("http://127.0.0.1:5173");
    await bob.goto("http://127.0.0.1:5173");
    await connectTwo(alice, bob);

    const secret = `p2p-secret-${Date.now()}`;
    await alice.getByLabel("Message").fill(secret);
    await alice.getByRole("button", { name: "Send over P2P" }).click();

    await expect(bob.getByText(secret)).toBeVisible({ timeout: 30_000 });
    await assertServerZeroStorage();

    await alice.getByRole("button", { name: "Disconnect signalling" }).click();
    const secret2 = `after-disconnect-${Date.now()}`;
    await alice.getByLabel("Message").fill(secret2);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(bob.getByText(secret2)).toBeVisible({ timeout: 30_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });

  test("offline catch-up: Bob returns and receives queued message", async ({ browser }) => {
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    const alice = await aliceCtx.newPage();
    let bob = await bobCtx.newPage();

    await alice.goto("http://127.0.0.1:5173");
    await bob.goto("http://127.0.0.1:5173");
    await connectTwo(alice, bob);

    const warm = `warm-${Date.now()}`;
    await alice.getByLabel("Message").fill(warm);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(bob.getByText(warm)).toBeVisible({ timeout: 30_000 });

    // Bob offline
    await bob.close();
    await expect(alice.getByText("P2P: connected")).toHaveCount(0, { timeout: 30_000 });

    const queued = `queued-while-offline-${Date.now()}`;
    await alice.getByLabel("Message").fill(queued);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(alice.getByText(queued)).toBeVisible({ timeout: 15_000 });
    // Pending outbox should be visible (banner and/or Outbox / Pending stats)
    await expect(alice.getByText(/Local outbox:/)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => alice.locator(".stat").filter({ hasText: "Outbox" }).locator(".v").textContent(), {
        timeout: 10_000,
      })
      .not.toBe("0");

    // Bob returns (same identity) and both re-dial once Bob's session is live
    bob = await bobCtx.newPage();
    await bob.goto("http://127.0.0.1:5173");
    const bobInvite2 = await readInvite(bob);
    const aliceInvite2 = await readInvite(alice);
    await addPeer(bob, aliceInvite2);
    await bob.waitForTimeout(1000);
    await addPeer(alice, bobInvite2);

    await expect(alice.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });

    const bobContact = bob
      .locator("section.panel")
      .filter({ hasText: "Add contact" })
      .locator(".contact button.secondary")
      .first();
    await bobContact.click();
    // Also nudge Alice's contact to flush outbox after the channel is up
    await alice
      .locator("section.panel")
      .filter({ hasText: "Add contact" })
      .locator(".contact button.secondary")
      .first()
      .click();

    await expect(bob.getByText(queued)).toBeVisible({ timeout: 60_000 });
    await assertServerZeroStorage();

    await aliceCtx.close();
    await bobCtx.close();
  });
});
