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

async function connectPair(a: Page, b: Page, aInvite: string, bInvite: string): Promise<void> {
  await addPeer(a, bInvite);
  await b.waitForTimeout(600);
  await addPeer(b, aInvite);
}

async function assertServerZeroStorage(): Promise<void> {
  const health = await (await fetch("http://127.0.0.1:8787/health")).json();
  expect(health.messagesStored).toBe(0);
  expect(health.messagePlaintextReceived).toBe(0);
  expect(health.contactListsReceived).toBe(0);
  expect(health.privateKeysReceived).toBe(0);
}

test.describe("Group chat P2P", () => {
  test("3-peer group message + pin; server stores zero", async ({ browser }) => {
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    const carolCtx: BrowserContext = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const carol = await carolCtx.newPage();

    await alice.goto("http://127.0.0.1:5173");
    await bob.goto("http://127.0.0.1:5173");
    await carol.goto("http://127.0.0.1:5173");

    const aliceInvite = await readInvite(alice);
    const bobInvite = await readInvite(bob);
    const carolInvite = await readInvite(carol);

    // Full mesh of contacts so createGroup wraps keys for everyone Alice knows
    await connectPair(alice, bob, aliceInvite, bobInvite);
    await expect(alice.getByText("P2P: connected").first()).toBeVisible({ timeout: 90_000 });

    await connectPair(alice, carol, aliceInvite, carolInvite);
    await expect(carol.getByText("P2P: connected").first()).toBeVisible({ timeout: 90_000 });

    await connectPair(bob, carol, bobInvite, carolInvite);
    await expect(bob.getByText("P2P: connected").first()).toBeVisible({ timeout: 90_000 });

    // Alice creates group with all contacts (Bob + Carol)
    await alice.getByLabel("Name").fill("e2e-trio");
    await alice.getByRole("button", { name: "Create group with all contacts" }).click();
    await expect(alice.getByRole("button", { name: /e2e-trio/ })).toBeVisible({ timeout: 15_000 });

    // Bob & Carol should receive signed epoch and see the group
    await expect(bob.getByRole("button", { name: /e2e-trio/ })).toBeVisible({ timeout: 60_000 });
    await expect(carol.getByRole("button", { name: /e2e-trio/ })).toBeVisible({ timeout: 60_000 });

    await bob.getByRole("button", { name: /e2e-trio/ }).click();
    await carol.getByRole("button", { name: /e2e-trio/ }).click();

    const secret = `group-secret-${Date.now()}`;
    await alice.locator("textarea").last().fill(secret);
    await alice.getByRole("button", { name: "Send over P2P" }).click();

    await expect(bob.getByText(secret)).toBeVisible({ timeout: 60_000 });
    await expect(carol.getByText(secret)).toBeVisible({ timeout: 60_000 });

    // Control message: pin visible on second peer
    await alice.getByRole("button", { name: "Pin" }).first().click();
    await expect(bob.getByText(/Pinned:/)).toBeVisible({ timeout: 30_000 });

    await assertServerZeroStorage();

    await aliceCtx.close();
    await bobCtx.close();
    await carolCtx.close();
  });
});
