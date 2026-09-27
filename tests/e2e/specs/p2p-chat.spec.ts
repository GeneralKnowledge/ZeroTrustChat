import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function readInvite(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: "ZeroTrustChat" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Copy invite" })).toBeVisible({ timeout: 60_000 });
  const area = page.locator("textarea").first();
  await expect(area).not.toHaveValue("");
  return area.inputValue();
}

async function addPeer(page: Page, invite: string): Promise<void> {
  const areas = page.locator("textarea");
  await areas.nth(1).fill(invite);
  await page.getByRole("button", { name: "Add & connect" }).click();
}

async function assertServerZeroStorage(): Promise<void> {
  const health = await (await fetch("http://127.0.0.1:8787/health")).json();
  expect(health.messagesStored).toBe(0);
  expect(health.messagePlaintextReceived).toBe(0);
  expect(health.contactListsReceived).toBe(0);
  expect(health.privateKeysReceived).toBe(0);
}

test.describe("P2P messaging privacy", () => {
  test("Alice and Bob chat over P2P; server stores zero messages", async ({ browser }) => {
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    await alice.goto("http://127.0.0.1:5173");
    await bob.goto("http://127.0.0.1:5173");

    const aliceInvite = await readInvite(alice);
    const bobInvite = await readInvite(bob);

    await addPeer(alice, bobInvite);
    await bob.waitForTimeout(800);
    await addPeer(bob, aliceInvite);

    await expect(alice.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });

    const secret = `p2p-secret-${Date.now()}`;
    await alice.locator("textarea").last().fill(secret);
    await alice.getByRole("button", { name: "Send over P2P" }).click();

    await expect(bob.getByText(secret)).toBeVisible({ timeout: 30_000 });
    await assertServerZeroStorage();

    await alice.getByRole("button", { name: "Disconnect signalling" }).click();
    const secret2 = `after-disconnect-${Date.now()}`;
    await alice.locator("textarea").last().fill(secret2);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(bob.getByText(secret2)).toBeVisible({ timeout: 30_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });

  test("offline catch-up: Bob returns and receives queued message", async ({ browser }) => {
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    let alice = await aliceCtx.newPage();
    let bob = await bobCtx.newPage();

    await alice.goto("http://127.0.0.1:5173");
    await bob.goto("http://127.0.0.1:5173");

    const aliceInvite = await readInvite(alice);
    const bobInvite = await readInvite(bob);

    await addPeer(alice, bobInvite);
    await bob.waitForTimeout(800);
    await addPeer(bob, aliceInvite);

    await expect(alice.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });

    // Warm path so conversation is active on Alice
    const warm = `warm-${Date.now()}`;
    await alice.locator("textarea").last().fill(warm);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(bob.getByText(warm)).toBeVisible({ timeout: 30_000 });

    // Bob goes offline (page closed; context keeps localStorage identity/contacts)
    await bob.close();

    const queued = `queued-while-offline-${Date.now()}`;
    await alice.locator("textarea").last().fill(queued);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    // Outbox should show pending on Alice dashboard eventually
    await expect(alice.getByText(/Pending \/ expired/)).toBeVisible();

    bob = await bobCtx.newPage();
    await bob.goto("http://127.0.0.1:5173");
    await expect(bob.getByRole("heading", { name: "ZeroTrustChat" })).toBeVisible({ timeout: 60_000 });

    // Reconnect: Alice dials Bob (contact button), Bob dials Alice
    const bobName = bob.getByRole("button", { name: /Copy invite/ }).locator(".."); // ensure loaded
    void bobName;
    // Contact buttons use display names — click first contact on each side
    const aliceContactBtn = alice.locator("aside .contact button.secondary").first();
    const bobContactBtn = bob.locator("aside .contact button.secondary").first();
    await expect(bobContactBtn).toBeVisible({ timeout: 30_000 });
    await aliceContactBtn.click();
    await bob.waitForTimeout(800);
    await bobContactBtn.click();

    await expect(alice.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });

    // Select conversation on Bob and wait for flush
    await bobContactBtn.click();
    await expect(bob.getByText(queued)).toBeVisible({ timeout: 60_000 });
    await assertServerZeroStorage();

    await aliceCtx.close();
    await bobCtx.close();
  });
});
