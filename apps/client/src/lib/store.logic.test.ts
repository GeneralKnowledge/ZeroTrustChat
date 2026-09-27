import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore";
import type { StoredMessage } from "./store";

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, "messageId" | "senderId">): StoredMessage {
  return {
    conversationId: partial.conversationId ?? "c1",
    ciphertext: partial.ciphertext ?? "c",
    nonce: partial.nonce ?? "n",
    messageKeyId: partial.messageKeyId ?? "k",
    createdAt: partial.createdAt ?? 1,
    deliveryDeadline: partial.deliveryDeadline ?? null,
    decryptionDeadline: partial.decryptionDeadline ?? null,
    retentionDeadline: partial.retentionDeadline ?? null,
    status: partial.status ?? "delivered",
    encryptionMetadata: partial.encryptionMetadata ?? "{}",
    wrappedKey: partial.wrappedKey ?? null,
    securityMode: partial.securityMode ?? "normal",
    plaintextCache: partial.plaintextCache ?? JSON.stringify({ v: 1, type: "text", body: "hi" }),
    messageId: partial.messageId,
    senderId: partial.senderId,
  };
}

describe("MemoryStore logic", () => {
  it("outbox CRUD and deadline filtering", () => {
    const s = new MemoryStore();
    s.enqueueOutbox("m1", "bob", "{}", 1000, 2000, null);
    s.enqueueOutbox("m2", "bob", "{}", 1000, null, null);
    expect(s.listOutbox(1500).map((o) => o.messageId).sort()).toEqual(["m1", "m2"]);
    expect(s.listOutbox(2500).map((o) => o.messageId)).toEqual(["m2"]);
    s.removeOutbox("m2");
    expect(s.listOutbox(2500)).toEqual([]);
  });

  it("deleteExpiredMessages drops past retention and delivery-deadline outbox", () => {
    const s = new MemoryStore();
    s.saveMessage(msg({ messageId: "keep", senderId: "a", retentionDeadline: 5000 }));
    s.saveMessage(msg({ messageId: "gone", senderId: "a", retentionDeadline: 1000 }));
    s.enqueueOutbox("out-gone", "b", "{}", 1, 1000, null);
    s.enqueueOutbox("out-keep", "b", "{}", 1, 9000, null);
    expect(s.deleteExpiredMessages(2000)).toBe(1);
    expect(s.getMessage("gone")).toBeNull();
    expect(s.getMessage("keep")).not.toBeNull();
    expect(s.listOutbox(2000).map((o) => o.messageId)).toEqual(["out-keep"]);
  });

  it("applyReaction set/clear is idempotent", () => {
    const s = new MemoryStore();
    s.applyReaction("m1", "alice", "👍", "set");
    s.applyReaction("m1", "alice", "👍", "set");
    expect(s.listReactions("m1")).toEqual([{ reactorId: "alice", emoji: "👍" }]);
    s.applyReaction("m1", "alice", "👍", "clear");
    s.applyReaction("m1", "alice", "👍", "clear");
    expect(s.listReactions("m1")).toEqual([]);
    s.applyReaction("m1", "bob", "❤️", "set");
    s.applyReaction("m1", "bob", "😂", "set");
    expect(s.listReactions("m1")).toEqual([{ reactorId: "bob", emoji: "😂" }]);
  });

  it("applyMessageEdit only succeeds for the original sender", () => {
    const s = new MemoryStore();
    s.saveMessage(msg({ messageId: "m1", senderId: "alice", plaintextCache: JSON.stringify({ v: 1, type: "text", body: "old" }) }));
    expect(s.applyMessageEdit("m1", "bob", "hacked")).toBe(false);
    expect(JSON.parse(s.getMessage("m1")!.plaintextCache!).body).toBe("old");
    expect(s.applyMessageEdit("m1", "alice", "new")).toBe(true);
    expect(JSON.parse(s.getMessage("m1")!.plaintextCache!).body).toBe("new");
    const meta = JSON.parse(s.getMessage("m1")!.encryptionMetadata) as { edited?: boolean };
    expect(meta.edited).toBe(true);
  });

  it("applyMessageEdit rejects deleted messages", () => {
    const s = new MemoryStore();
    s.saveMessage(msg({ messageId: "m1", senderId: "alice" }));
    s.markMessageDeleted("m1");
    expect(s.applyMessageEdit("m1", "alice", "nope")).toBe(false);
  });

  it("pin toggle set/clear", () => {
    const s = new MemoryStore();
    s.applyPin("c1", "m1", "alice", "set");
    expect(s.isPinned("c1", "m1")).toBe(true);
    s.applyPin("c1", "m1", "alice", "set");
    expect(s.listPins("c1")).toHaveLength(1);
    s.applyPin("c1", "m1", "alice", "clear");
    expect(s.isPinned("c1", "m1")).toBe(false);
    s.applyPin("c1", "m1", "alice", "clear");
    expect(s.listPins("c1")).toHaveLength(0);
  });

  it("markMessageDeleted clears plaintext cache", () => {
    const s = new MemoryStore();
    s.saveMessage(msg({ messageId: "m1", senderId: "alice" }));
    s.markMessageDeleted("m1");
    expect(s.getMessage("m1")!.status).toBe("deleted");
    expect(s.getMessage("m1")!.plaintextCache).toBeNull();
  });
});
