/**
 * Offline queue behaviour via MessagingService + FakeP2P (no network).
 * Protocol mailbox forbids are also asserted so offline never implies server deposit.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORBIDDEN_TYPES, parseClientMessage } from "@ztc/protocol";
import { FakeP2pHub } from "./lib/test/fakeP2p";
import { createSimPeer, linkContacts, type SimPeer } from "./lib/test/simPeer";

describe("offline behaviour", () => {
  let hub: FakeP2pHub;
  let alice: SimPeer;
  let bob: SimPeer;

  beforeEach(() => {
    hub = new FakeP2pHub();
    alice = createSimPeer(hub, "alice");
    bob = createSimPeer(hub, "bob");
    linkContacts([alice, bob]);
    alice.messaging.start();
    bob.messaging.start();
  });

  afterEach(() => {
    alice.messaging.stop();
    bob.messaging.stop();
  });

  it("does not define any server mailbox operation", () => {
    for (const type of ["mailbox_deposit", "mailbox_fetch", "store_message", "send_message"] as const) {
      expect(FORBIDDEN_TYPES).toContain(type);
      const result = parseClientMessage({
        type,
        ciphertext: "aabb",
        to: "bob",
      });
      expect(result.ok).toBe(false);
    }
  });

  it("send while peer offline stays in local outbox only", async () => {
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "stay-local",
      "normal",
    );
    expect(alice.store.listOutbox().map((o) => o.messageId)).toContain(mid);
    expect(alice.store.getMessage(mid)?.status).toBe("pending");
    expect(bob.store.getMessage(mid)).toBeNull();
    expect(hub.metrics().totalSends()).toBe(0);
  });

  it("reconnect flushes outbox over P2P and clears local queue", async () => {
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "deliver-later",
      "normal",
    );
    expect(alice.store.listOutbox()).toHaveLength(1);

    hub.connect(alice.identity.peerId, bob.identity.peerId);
    expect(bob.store.getMessage(mid)?.plaintextCache).toContain("deliver-later");
    expect(alice.store.listOutbox()).toHaveLength(0);
    expect(alice.store.getMessage(mid)?.status).toBe("delivered");
  });
});
