import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptWithMessageKey,
  encryptWithMessageKey,
  generateMessageKey,
  destroyMessageKey,
} from "@ztc/crypto";
import { resolvePolicy } from "@ztc/shared";
import { FakeP2pHub } from "./lib/test/fakeP2p";
import { createSimPeer, linkContacts, type SimPeer } from "./lib/test/simPeer";

/**
 * Expiry / time-limited decryption — crypto primitives plus MessagingService outbox filters.
 */

describe("message expiry policies", () => {
  it("expiring mode sets delivery and retention windows", () => {
    const now = 1_700_000_000_000;
    const p = resolvePolicy("expiring", undefined, now);
    expect(p.deliveryDeadlineMs).toBe(24 * 60 * 60 * 1000);
    expect(p.retentionDeadlineMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("time-limited decryption destroys key after deadline", () => {
    const key = generateMessageKey({ decryptionDeadlineAt: Date.now() + 60_000 });
    const enc = encryptWithMessageKey("Meet me at 8.", key);
    key.decryptionDeadlineAt = Date.now() - 1;
    expect(() => decryptWithMessageKey(enc, key)).toThrow(/deadline/);
    expect(key.destroyed).toBe(true);
    expect(() => decryptWithMessageKey(enc, key)).toThrow(/destroyed/);
  });

  it("destroyed key leaves ciphertext useless", () => {
    const key = generateMessageKey();
    const enc = encryptWithMessageKey("secret", key);
    destroyMessageKey(key);
    expect(key.key).toBe("");
    expect(() => decryptWithMessageKey(enc, key)).toThrow();
  });
});

describe("MessagingService delivery deadline", () => {
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
    vi.useRealTimers();
  });

  it("past delivery deadline is dropped from outbox and never delivered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "expired-send",
      "expiring",
      { deliveryDeadlineMs: 5_000 },
    );
    expect(alice.store.listOutbox(1_000_000).map((o) => o.messageId)).toContain(mid);

    vi.setSystemTime(1_010_000);
    expect(alice.store.deleteExpiredMessages(1_010_000)).toBeGreaterThanOrEqual(0);
    expect(alice.store.listOutbox(1_010_000).map((o) => o.messageId)).not.toContain(mid);

    hub.connect(alice.identity.peerId, bob.identity.peerId);
    await alice.messaging.flushOutbox(bob.identity.peerId);
    expect(bob.store.getMessage(mid)).toBeNull();
  });
});
