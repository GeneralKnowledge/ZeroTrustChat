import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encryptWithMessageKey,
  generateMessageKey,
  wrapMessageKeyForPeer,
} from "@ztc/crypto";
import { FakeP2pHub } from "./test/fakeP2p";
import { createSimPeer, linkContacts, textBodies, type SimPeer } from "./test/simPeer";
import { encodeAppMessage, parseAppMessage } from "./appMessage";

function injectEncryptedApp(from: SimPeer, to: SimPeer, app: Parameters<typeof encodeAppMessage>[0]): void {
  const plaintext = encodeAppMessage(app);
  const messageKey = generateMessageKey({});
  const encrypted = encryptWithMessageKey(plaintext, messageKey);
  const wrappedKey = wrapMessageKeyForPeer(
    messageKey,
    from.identity.privateKey,
    to.identity.publicKey,
  );
  const messageId = crypto.randomUUID();
  const conversationId = [from.identity.peerId, to.identity.peerId].sort().join(":");
  from.p2p.send(to.identity.peerId, {
    v: 1,
    kind: "chat",
    payload: {
      messageId,
      conversationId,
      senderId: from.identity.peerId,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      messageKeyId: encrypted.messageKeyId,
      wrappedKey,
      createdAt: Date.now(),
      deliveryDeadline: null,
      decryptionDeadline: null,
      retentionDeadline: null,
      securityMode: "normal",
      encryptionMetadata: encrypted.encryptionMetadata,
    },
  });
}

describe("MessagingService FakeP2P simulation", () => {
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

  it("online send → peer decrypts body", async () => {
    hub.connect(alice.identity.peerId, bob.identity.peerId);
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "hello-online",
      "normal",
    );
    expect(mid).toBeTruthy();
    const bodies = textBodies(bob, [alice.identity.peerId, bob.identity.peerId].sort().join(":"));
    expect(bodies).toContain("hello-online");
    expect(alice.store.listOutbox()).toHaveLength(0);
  });

  it("offline send queues outbox; reconnect flushes and delivers", async () => {
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "queued-msg",
      "normal",
    );
    expect(alice.store.listOutbox().map((o) => o.messageId)).toContain(mid);
    expect(bob.store.getMessage(mid)).toBeNull();

    hub.connect(alice.identity.peerId, bob.identity.peerId);
    // onState connected flushes immediately
    expect(bob.store.getMessage(mid)?.plaintextCache).toContain("queued-msg");
    expect(alice.store.listOutbox()).toHaveLength(0);
    expect(alice.store.getMessage(mid)?.status).toBe("delivered");
  });

  it("delivery deadline passed → outbox entry not resent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "too-late",
      "normal",
      { deliveryDeadlineMs: 5_000 },
    );
    expect(alice.store.listOutbox(1_000_000).map((o) => o.messageId)).toContain(mid);

    vi.setSystemTime(1_010_000);
    alice.store.deleteExpiredMessages(1_010_000);
    expect(alice.store.listOutbox(1_010_000).map((o) => o.messageId)).not.toContain(mid);

    hub.connect(alice.identity.peerId, bob.identity.peerId);
    expect(bob.store.getMessage(mid)).toBeNull();
  });

  it("reply / like / edit / delete / pin apply; non-sender edit/delete ignored", async () => {
    hub.connect(alice.identity.peerId, bob.identity.peerId);
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "original",
      "normal",
    );
    const conv = [alice.identity.peerId, bob.identity.peerId].sort().join(":");

    await alice.messaging.sendReply(
      bob.identity.peerId,
      bob.identity.publicKey,
      "reply-body",
      mid,
      "normal",
    );
    expect(textBodies(bob, conv)).toContain("reply-body");

    await bob.messaging.sendReaction(
      alice.identity.peerId,
      alice.identity.publicKey,
      mid,
      "👍",
    );
    expect(alice.store.listReactions(mid)).toEqual([{ reactorId: bob.identity.peerId, emoji: "👍" }]);

    await alice.messaging.sendEdit(
      bob.identity.peerId,
      bob.identity.publicKey,
      mid,
      "edited",
    );
    expect(parseAppMessage(bob.store.getMessage(mid)!.plaintextCache!).type).toBe("text");
    expect(JSON.parse(bob.store.getMessage(mid)!.plaintextCache!).body).toBe("edited");

    // Bob tries to edit Alice's message locally — store rejects
    expect(bob.store.applyMessageEdit(mid, bob.identity.peerId, "evil")).toBe(false);
    // Forged edit control from Bob is ignored on Alice (owner check)
    injectEncryptedApp(bob, alice, { v: 1, type: "edit", targetId: mid, body: "forged" });
    expect(JSON.parse(alice.store.getMessage(mid)!.plaintextCache!).body).toBe("edited");
    injectEncryptedApp(bob, alice, { v: 1, type: "delete", targetId: mid });
    expect(alice.store.getMessage(mid)!.status).not.toBe("deleted");

    await alice.messaging.sendPin(
      bob.identity.peerId,
      bob.identity.publicKey,
      conv,
      mid,
    );
    expect(bob.store.isPinned(conv, mid)).toBe(true);

    await alice.messaging.sendDelete(
      bob.identity.peerId,
      bob.identity.publicKey,
      mid,
    );
    expect(bob.store.getMessage(mid)!.status).toBe("deleted");

    await expect(
      bob.messaging.sendDelete(alice.identity.peerId, alice.identity.publicKey, mid),
    ).rejects.toThrow(/own messages/);
  });

  it("duplicate delivery of same messageId does not duplicate UI state", async () => {
    hub.connect(alice.identity.peerId, bob.identity.peerId);
    const mid = await alice.messaging.sendDirect(
      bob.identity.peerId,
      bob.identity.publicKey,
      "once",
      "normal",
    );
    const stored = alice.store.getMessage(mid)!;
    const envelope = {
      v: 1 as const,
      kind: "chat" as const,
      payload: {
        messageId: mid,
        conversationId: stored.conversationId,
        senderId: stored.senderId,
        ciphertext: stored.ciphertext,
        nonce: stored.nonce,
        messageKeyId: stored.messageKeyId,
        wrappedKey: stored.wrappedKey!,
        createdAt: stored.createdAt,
        deliveryDeadline: stored.deliveryDeadline,
        decryptionDeadline: stored.decryptionDeadline,
        retentionDeadline: stored.retentionDeadline,
        securityMode: stored.securityMode,
        encryptionMetadata: { algorithm: "AES-256-GCM", version: 1 },
      },
    };
    // Re-inject same envelope
    bob.p2p.receive(alice.identity.peerId, envelope);
    bob.p2p.receive(alice.identity.peerId, envelope);
    const copies = bob.store.listMessages(stored.conversationId).filter((m) => m.messageId === mid);
    expect(copies).toHaveLength(1);
  });
});
