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

    // Stagger so the smaller peerId can complete offer before the other side dials.
    await addPeer(alice, bobInvite);
    await bob.waitForTimeout(800);
    await addPeer(bob, aliceInvite);

    await expect(alice.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByText("P2P: connected")).toBeVisible({ timeout: 90_000 });

    const secret = `p2p-secret-${Date.now()}`;
    await alice.locator("textarea").last().fill(secret);
    await alice.getByRole("button", { name: "Send over P2P" }).click();

    await expect(bob.getByText(secret)).toBeVisible({ timeout: 30_000 });

    const health = await (await fetch("http://127.0.0.1:8787/health")).json();
    expect(health.messagesStored).toBe(0);
    expect(health.messagePlaintextReceived).toBe(0);
    expect(health.contactListsReceived).toBe(0);
    expect(health.privateKeysReceived).toBe(0);

    await alice.getByRole("button", { name: "Disconnect signalling" }).click();
    const secret2 = `after-disconnect-${Date.now()}`;
    await alice.locator("textarea").last().fill(secret2);
    await alice.getByRole("button", { name: "Send over P2P" }).click();
    await expect(bob.getByText(secret2)).toBeVisible({ timeout: 30_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });
});
