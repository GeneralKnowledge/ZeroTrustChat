import { describe, expect, it } from "vitest";
import {
  decryptWithMessageKey,
  destroyMessageKey,
  encryptWithMessageKey,
  generateGroupEpochKey,
  encryptGroupMessage,
  decryptGroupMessage,
  generateIdentity,
  generateMessageKey,
  isKeyAvailable,
  wrapMessageKeyForPeer,
  unwrapMessageKeyFromPeer,
  wrapEpochKeyForPeer,
  unwrapEpochKeyFromPeer,
  signEpochAnnouncement,
  verifyEpochAnnouncement,
  sealIdentityBackup,
  openIdentityBackup,
} from "./index.js";

describe("identity", () => {
  it("generates distinct identities", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.peerId).not.toBe(b.peerId);
    expect(a.displayName).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });
});

describe("message encryption", () => {
  it("round-trips plaintext", () => {
    const key = generateMessageKey();
    const enc = encryptWithMessageKey("hello p2p", key);
    const plain = decryptWithMessageKey(enc, key);
    expect(plain).toBe("hello p2p");
  });

  it("fails after key destruction", () => {
    const key = generateMessageKey();
    const enc = encryptWithMessageKey("secret", key);
    destroyMessageKey(key);
    expect(() => decryptWithMessageKey(enc, key)).toThrow(/destroyed/);
  });

  it("enforces decryption deadline", () => {
    const key = generateMessageKey({ decryptionDeadlineAt: Date.now() + 60_000 });
    const enc = encryptWithMessageKey("Meet me at 8.", key);
    key.decryptionDeadlineAt = Date.now() - 1;
    expect(() => decryptWithMessageKey(enc, key)).toThrow(/deadline/);
    expect(key.destroyed).toBe(true);
  });

  it("one-time destroys key after decrypt", () => {
    const key = generateMessageKey({ oneTime: true });
    const enc = encryptWithMessageKey("once", key);
    expect(decryptWithMessageKey(enc, key)).toBe("once");
    expect(key.destroyed).toBe(true);
    expect(isKeyAvailable(key)).toBe(false);
  });
});

describe("key wrapping", () => {
  it("wraps and unwraps for peer", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const mk = generateMessageKey();
    const wrapped = wrapMessageKeyForPeer(mk, alice.privateKey, bob.publicKey);
    const unwrapped = unwrapMessageKeyFromPeer(wrapped, bob.privateKey, alice.publicKey);
    expect(unwrapped.key).toBe(mk.key);
    expect(unwrapped.messageKeyId).toBe(mk.messageKeyId);
  });
});

describe("group epoch keys", () => {
  it("encrypts with epoch; removed member cannot use new epoch", () => {
    const members1 = ["alice", "bob", "charlie", "dave"];
    const epoch1 = generateGroupEpochKey("g1", 1, members1);
    const enc1 = encryptGroupMessage("hi all", epoch1);
    expect(decryptGroupMessage(enc1, epoch1)).toBe("hi all");

    const members2 = ["alice", "bob", "dave"];
    const epoch2 = generateGroupEpochKey("g1", 2, members2);
    const enc2 = encryptGroupMessage("after charlie left", epoch2);
    expect(decryptGroupMessage(enc2, epoch2)).toBe("after charlie left");
    expect(() => decryptGroupMessage(enc2, epoch1)).toThrow();
  });

  it("wraps epoch key per member and verifies signed announcement", () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const epoch = generateGroupEpochKey("g2", 1, [alice.peerId, bob.peerId]);
    const wrapped = wrapEpochKeyForPeer(epoch.key, alice.privateKey, bob.publicKey);
    expect(unwrapEpochKeyFromPeer(wrapped, bob.privateKey, alice.publicKey)).toBe(epoch.key);

    const fields = {
      groupId: "g2",
      name: "test",
      epoch: 1,
      prevEpoch: 0,
      members: [alice.peerId, bob.peerId],
      epochId: "eid-1",
      changerId: alice.peerId,
    };
    const sig = signEpochAnnouncement(fields, alice.signingPrivateKey);
    expect(verifyEpochAnnouncement(fields, sig, alice.signingPublicKey)).toBe(true);
    expect(verifyEpochAnnouncement(fields, sig, bob.signingPublicKey)).toBe(false);
  });
});

describe("identity backup", () => {
  it("round-trips sealed identity with passphrase", () => {
    const id = generateIdentity();
    const sealed = sealIdentityBackup(
      {
        v: 1,
        peerId: id.peerId,
        publicKey: id.publicKey,
        privateKey: id.privateKey,
        signingPublicKey: id.signingPublicKey,
        signingPrivateKey: id.signingPrivateKey,
        displayName: id.displayName,
      },
      "correct horse battery",
    );
    const opened = openIdentityBackup(sealed, "correct horse battery");
    expect(opened.peerId).toBe(id.peerId);
    expect(opened.privateKey).toBe(id.privateKey);
    expect(() => openIdentityBackup(sealed, "wrong passphrase")).toThrow();
  });
});
