/**
 * Application messaging — encrypts locally, sends over P2P DataChannel.
 * Never talks to the network directly.
 */

import {
  decryptWithMessageKey,
  encryptWithMessageKey,
  generateMessageKey,
  wrapMessageKeyForPeer,
  unwrapMessageKeyFromPeer,
  type MessageKeyRecord,
} from "@ztc/crypto";
import { resolvePolicy, type SecurityMode, type SecurityPolicy } from "@ztc/shared";
import type { P2pManager, P2pEnvelope } from "./p2p";
import type { LocalIdentity } from "./store";
import * as store from "./store";
import { encodeAppMessage, parseAppMessage, type AppMessage } from "./appMessage";

export interface ChatPayload {
  messageId: string;
  conversationId: string;
  senderId: string;
  ciphertext: string;
  nonce: string;
  messageKeyId: string;
  wrappedKey: string;
  createdAt: number;
  deliveryDeadline: number | null;
  decryptionDeadline: number | null;
  retentionDeadline: number | null;
  securityMode: SecurityMode;
  encryptionMetadata: { algorithm: string; version: number };
}

export class MessagingService {
  private readonly p2p: P2pManager;
  private readonly identity: LocalIdentity;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(p2p: P2pManager, identity: LocalIdentity) {
    this.p2p = p2p;
    this.identity = identity;
    p2p.onData((from, env) => {
      if (env.kind === "chat") void this.handleIncoming(from, env.payload as ChatPayload);
      if (env.kind === "ack") {
        const { messageId } = env.payload as { messageId: string };
        store.updateMessageStatus(messageId, "delivered");
        store.removeOutbox(messageId);
      }
    });
    p2p.onState((peerId, state) => {
      if (state === "connected") void this.flushOutboxFor(peerId);
    });
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      store.deleteExpiredMessages();
      void this.flushAllOutbox();
    }, 2000);
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  async sendDirect(
    recipientPeerId: string,
    recipientPublicKey: string,
    plaintext: string,
    mode: SecurityMode,
    overrides?: Partial<SecurityPolicy>,
  ): Promise<string> {
    return this.sendDirectApp(
      recipientPeerId,
      recipientPublicKey,
      { v: 1, type: "text", body: plaintext },
      mode,
      overrides,
    );
  }

  async sendReply(
    recipientPeerId: string,
    recipientPublicKey: string,
    body: string,
    replyTo: string,
    mode: SecurityMode,
    overrides?: Partial<SecurityPolicy>,
  ): Promise<string> {
    return this.sendDirectApp(
      recipientPeerId,
      recipientPublicKey,
      { v: 1, type: "text", body, replyTo },
      mode,
      overrides,
    );
  }

  async sendReaction(
    recipientPeerId: string,
    recipientPublicKey: string,
    targetId: string,
    emoji: string,
  ): Promise<string> {
    const mine = store.listReactions(targetId).find((r) => r.reactorId === this.identity.peerId);
    const op = mine?.emoji === emoji ? "clear" : "set";
    store.applyReaction(targetId, this.identity.peerId, emoji, op);
    return this.sendDirectApp(
      recipientPeerId,
      recipientPublicKey,
      { v: 1, type: "reaction", targetId, emoji, op },
      "normal",
    );
  }

  async sendDelete(
    recipientPeerId: string,
    recipientPublicKey: string,
    targetId: string,
  ): Promise<string> {
    const target = store.getMessage(targetId);
    if (!target || target.senderId !== this.identity.peerId) {
      throw new Error("Can only delete your own messages");
    }
    store.markMessageDeleted(targetId);
    return this.sendDirectApp(
      recipientPeerId,
      recipientPublicKey,
      { v: 1, type: "delete", targetId },
      "normal",
    );
  }

  async sendEdit(
    recipientPeerId: string,
    recipientPublicKey: string,
    targetId: string,
    body: string,
  ): Promise<string> {
    if (!store.applyMessageEdit(targetId, this.identity.peerId, body)) {
      throw new Error("Can only edit your own messages");
    }
    return this.sendDirectApp(
      recipientPeerId,
      recipientPublicKey,
      { v: 1, type: "edit", targetId, body },
      "normal",
    );
  }

  async sendPin(
    recipientPeerId: string,
    recipientPublicKey: string,
    conversationId: string,
    targetId: string,
  ): Promise<string> {
    const pinned = store.isPinned(conversationId, targetId);
    const op = pinned ? "clear" : "set";
    store.applyPin(conversationId, targetId, this.identity.peerId, op);
    return this.sendDirectApp(
      recipientPeerId,
      recipientPublicKey,
      { v: 1, type: "pin", targetId, op },
      "normal",
    );
  }

  private async sendDirectApp(
    recipientPeerId: string,
    recipientPublicKey: string,
    app: AppMessage,
    mode: SecurityMode,
    overrides?: Partial<SecurityPolicy>,
  ): Promise<string> {
    const plaintext = encodeAppMessage(app);
    const now = Date.now();
    const policy = resolvePolicy(mode, overrides, now);
    const messageKey = generateMessageKey({
      decryptionDeadlineAt: policy.decryptionDeadlineAt,
      oneTime: policy.oneTime,
    });
    const encrypted = encryptWithMessageKey(plaintext, messageKey);
    const wrappedKey = wrapMessageKeyForPeer(
      messageKey,
      this.identity.privateKey,
      recipientPublicKey,
    );

    const messageId = crypto.randomUUID();
    const conversationId = [this.identity.peerId, recipientPeerId].sort().join(":");
    const deliveryDeadline =
      policy.deliveryDeadlineMs !== undefined ? now + policy.deliveryDeadlineMs : null;
    const retentionDeadline =
      policy.retentionDeadlineMs !== undefined ? now + policy.retentionDeadlineMs : null;

    store.saveMessageKey({
      messageKeyId: messageKey.messageKeyId,
      keyHex: messageKey.key,
      decryptionDeadlineAt: messageKey.decryptionDeadlineAt ?? null,
      oneTime: messageKey.oneTime ? 1 : 0,
      destroyed: 0,
    });

    const payload: ChatPayload = {
      messageId,
      conversationId,
      senderId: this.identity.peerId,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      messageKeyId: encrypted.messageKeyId,
      wrappedKey,
      createdAt: now,
      deliveryDeadline,
      decryptionDeadline: policy.decryptionDeadlineAt ?? null,
      retentionDeadline,
      securityMode: mode,
      encryptionMetadata: encrypted.encryptionMetadata,
    };

    store.saveMessage({
      messageId,
      conversationId,
      senderId: this.identity.peerId,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      messageKeyId: encrypted.messageKeyId,
      createdAt: now,
      deliveryDeadline,
      decryptionDeadline: policy.decryptionDeadlineAt ?? null,
      retentionDeadline,
      status: "pending",
      encryptionMetadata: JSON.stringify(encrypted.encryptionMetadata),
      wrappedKey,
      securityMode: mode,
      plaintextCache: plaintext,
    });

    const envelope: P2pEnvelope = { v: 1, kind: "chat", payload };
    const sent = this.p2p.send(recipientPeerId, envelope);
    if (sent) {
      store.updateMessageStatus(messageId, "delivered", plaintext);
    } else {
      store.enqueueOutbox(
        messageId,
        recipientPeerId,
        JSON.stringify(envelope),
        now,
        deliveryDeadline,
        retentionDeadline,
      );
      store.updateMessageStatus(messageId, "pending", plaintext);
    }
    return messageId;
  }

  tryDecryptLocal(messageId: string): string | null {
    const messages = store.listAllMessages();
    const m = messages.find((x) => x.messageId === messageId);
    if (!m) return null;
    if (m.plaintextCache) return m.plaintextCache;

    const keyRow = store.getMessageKey(m.messageKeyId);
    if (!keyRow || keyRow.destroyed || !keyRow.keyHex) return null;

    const record: MessageKeyRecord = {
      messageKeyId: keyRow.messageKeyId,
      key: keyRow.keyHex,
      decryptionDeadlineAt: keyRow.decryptionDeadlineAt ?? undefined,
      oneTime: keyRow.oneTime === 1,
      destroyed: false,
    };

    try {
      const plain = decryptWithMessageKey({ ciphertext: m.ciphertext, nonce: m.nonce }, record);
      if (record.destroyed) {
        store.destroyStoredMessageKey(m.messageKeyId);
      }
      store.updateMessageStatus(messageId, record.destroyed ? "key_destroyed" : "decrypted", plain);
      return plain;
    } catch {
      store.destroyStoredMessageKey(m.messageKeyId);
      return null;
    }
  }

  private async handleIncoming(fromPeerId: string, payload: ChatPayload): Promise<void> {
    const contact = store.listContacts().find((c) => c.peerId === fromPeerId);
    const senderPub = contact?.publicKey ?? fromPeerId;

    let messageKey: MessageKeyRecord;
    try {
      messageKey = unwrapMessageKeyFromPeer(payload.wrappedKey, this.identity.privateKey, senderPub);
    } catch {
      return;
    }

    store.saveMessageKey({
      messageKeyId: messageKey.messageKeyId,
      keyHex: messageKey.key,
      decryptionDeadlineAt: messageKey.decryptionDeadlineAt ?? null,
      oneTime: messageKey.oneTime ? 1 : 0,
      destroyed: 0,
    });

    let plaintext: string | null = null;
    try {
      plaintext = decryptWithMessageKey(
        { ciphertext: payload.ciphertext, nonce: payload.nonce },
        messageKey,
      );
    } catch {
      plaintext = null;
    }

    if (messageKey.destroyed) {
      store.destroyStoredMessageKey(messageKey.messageKeyId);
    }

    store.saveMessage({
      messageId: payload.messageId,
      conversationId: payload.conversationId,
      senderId: payload.senderId,
      ciphertext: payload.ciphertext,
      nonce: payload.nonce,
      messageKeyId: payload.messageKeyId,
      createdAt: payload.createdAt,
      deliveryDeadline: payload.deliveryDeadline,
      decryptionDeadline: payload.decryptionDeadline,
      retentionDeadline: payload.retentionDeadline,
      status: messageKey.destroyed ? "key_destroyed" : plaintext ? "decrypted" : "delivered",
      encryptionMetadata: JSON.stringify(payload.encryptionMetadata),
      wrappedKey: payload.wrappedKey,
      securityMode: payload.securityMode,
      plaintextCache: plaintext,
    });

    if (plaintext) applyIncomingAppEffects(payload.senderId, plaintext);

    this.p2p.send(fromPeerId, {
      v: 1,
      kind: "ack",
      payload: { messageId: payload.messageId },
    });
  }

  private async flushAllOutbox(): Promise<void> {
    const items = store.listOutbox();
    for (const item of items) {
      await this.flushOutboxFor(item.recipientPeerId);
    }
  }

  private async flushOutboxFor(peerId: string): Promise<void> {
    if (!this.p2p.isConnected(peerId)) return;
    const items = store.listOutbox().filter((i) => i.recipientPeerId === peerId);
    for (const item of items) {
      const envelope = JSON.parse(item.payloadJson) as P2pEnvelope;
      if (this.p2p.send(peerId, envelope)) {
        store.updateMessageStatus(item.messageId, "delivered");
        store.removeOutbox(item.messageId);
      }
    }
  }
}

function applyIncomingAppEffects(senderId: string, plaintext: string): void {
  const app = parseAppMessage(plaintext);
  if (app.type === "reaction") {
    store.applyReaction(app.targetId, senderId, app.emoji, app.op);
  } else if (app.type === "delete") {
    const target = store.getMessage(app.targetId);
    if (target && target.senderId === senderId) {
      store.markMessageDeleted(app.targetId);
    }
  } else if (app.type === "edit") {
    store.applyMessageEdit(app.targetId, senderId, app.body);
  } else if (app.type === "pin") {
    const target = store.getMessage(app.targetId);
    if (target) {
      store.applyPin(target.conversationId, app.targetId, senderId, app.op);
    }
  }
}
