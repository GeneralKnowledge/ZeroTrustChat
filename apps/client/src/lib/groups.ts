/**
 * Simple P2P mesh group chats with cryptographic epochs.
 *
 * Prototype simplification: group key is a shared AES key per epoch,
 * distributed to current members over existing P2P channels.
 * Production should use a proper continuous group key agreement (e.g. MLS).
 */

import {
  decryptGroupMessage,
  encryptGroupMessage,
  generateGroupEpochKey,
  type GroupEpochKey,
} from "@ztc/crypto";
import type { P2pManager, P2pEnvelope } from "./p2p";
import type { LocalIdentity } from "./store";
import * as store from "./store";

export interface GroupChatPayload {
  groupId: string;
  epoch: number;
  messageId: string;
  senderId: string;
  ciphertext: string;
  nonce: string;
  createdAt: number;
  deliveryDeadline: number | null;
}

export interface GroupEpochPayload {
  groupId: string;
  name: string;
  epoch: number;
  members: string[];
  epochKeyHex: string;
}

export interface GroupSyncPayload {
  groupId: string;
  messages: GroupChatPayload[];
}

export class GroupService {
  private readonly p2p: P2pManager;
  private readonly identity: LocalIdentity;
  private listeners = new Set<() => void>();

  constructor(p2p: P2pManager, identity: LocalIdentity) {
    this.p2p = p2p;
    this.identity = identity;
    p2p.onData((from, env) => {
      if (env.kind === "group_epoch") this.handleEpoch(env.payload as GroupEpochPayload);
      if (env.kind === "group_chat") this.handleChat(from, env.payload as GroupChatPayload);
      if (env.kind === "group_sync") this.handleSync(env.payload as GroupSyncPayload);
    });
    p2p.onState((peerId, state) => {
      if (state === "connected") this.syncMissedTo(peerId);
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  createGroup(name: string, memberPeerIds: string[]): string {
    const groupId = crypto.randomUUID();
    const members = Array.from(new Set([this.identity.peerId, ...memberPeerIds])).sort();
    const epochKey = generateGroupEpochKey(groupId, 1, members);
    store.saveGroup({
      groupId,
      name,
      epoch: 1,
      membersJson: JSON.stringify(members),
      epochKeyHex: epochKey.key,
      createdAt: Date.now(),
    });
    this.distributeEpoch(name, epochKey);
    this.notify();
    return groupId;
  }

  /** Membership change → new epoch. Removed members do not receive new key. */
  updateMembership(groupId: string, newMemberPeerIds: string[]): void {
    const g = store.getGroup(groupId);
    if (!g) throw new Error("Group not found");
    const members = Array.from(new Set([this.identity.peerId, ...newMemberPeerIds])).sort();
    const epoch = g.epoch + 1;
    const epochKey = generateGroupEpochKey(groupId, epoch, members);
    store.saveGroup({
      ...g,
      epoch,
      membersJson: JSON.stringify(members),
      epochKeyHex: epochKey.key,
    });
    this.distributeEpoch(g.name, epochKey);
    this.notify();
  }

  sendGroupMessage(groupId: string, plaintext: string, deliveryDeadlineMs?: number): string {
    const g = store.getGroup(groupId);
    if (!g) throw new Error("Group not found");
    const members = JSON.parse(g.membersJson) as string[];
    if (!members.includes(this.identity.peerId)) throw new Error("Not a member");

    const epochKey: GroupEpochKey = {
      groupId,
      epoch: g.epoch,
      key: g.epochKeyHex,
      memberPeerIds: members,
    };
    const enc = encryptGroupMessage(plaintext, epochKey);
    const messageId = crypto.randomUUID();
    const now = Date.now();
    const deliveryDeadline = deliveryDeadlineMs !== undefined ? now + deliveryDeadlineMs : null;

    const payload: GroupChatPayload = {
      groupId,
      epoch: g.epoch,
      messageId,
      senderId: this.identity.peerId,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      createdAt: now,
      deliveryDeadline,
    };

    store.saveMessage({
      messageId,
      conversationId: `group:${groupId}`,
      senderId: this.identity.peerId,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      messageKeyId: enc.messageKeyId,
      createdAt: now,
      deliveryDeadline,
      decryptionDeadline: null,
      retentionDeadline: null,
      status: "delivered",
      encryptionMetadata: JSON.stringify(enc.encryptionMetadata),
      wrappedKey: null,
      securityMode: "normal",
      plaintextCache: plaintext,
    });

    const envelope: P2pEnvelope = { v: 1, kind: "group_chat", payload };
    for (const member of members) {
      if (member === this.identity.peerId) continue;
      if (!this.p2p.send(member, envelope)) {
        // Retain locally for device-to-device sync when peer reconnects
        store.enqueueOutbox(
          `${messageId}:${member}`,
          member,
          JSON.stringify(envelope),
          now,
          deliveryDeadline,
          deliveryDeadline,
        );
      }
    }
    this.notify();
    return messageId;
  }

  /** Device-to-device sync of recent group ciphertext to a reconnecting member. */
  syncMissedTo(peerId: string): void {
    for (const g of store.listGroups()) {
      const members = JSON.parse(g.membersJson) as string[];
      if (!members.includes(peerId)) continue;
      const msgs = store
        .listMessages(`group:${g.groupId}`)
        .filter((m) => m.status !== "expired")
        .slice(-50)
        .map(
          (m): GroupChatPayload => ({
            groupId: g.groupId,
            epoch: Number(m.messageKeyId.split(":epoch:")[1] ?? g.epoch),
            messageId: m.messageId,
            senderId: m.senderId,
            ciphertext: m.ciphertext,
            nonce: m.nonce,
            createdAt: m.createdAt,
            deliveryDeadline: m.deliveryDeadline,
          }),
        );
      if (msgs.length === 0) continue;
      this.p2p.send(peerId, {
        v: 1,
        kind: "group_sync",
        payload: { groupId: g.groupId, messages: msgs } satisfies GroupSyncPayload,
      });
    }
  }

  decryptStoredGroupMessage(messageId: string): string | null {
    const m = store.listAllMessages().find((x) => x.messageId === messageId);
    if (!m || !m.conversationId.startsWith("group:")) return null;
    if (m.plaintextCache) return m.plaintextCache;
    const groupId = m.conversationId.slice("group:".length);
    const g = store.getGroup(groupId);
    if (!g) return null;
    const epoch = Number(m.messageKeyId.split(":epoch:")[1] ?? g.epoch);
    // Only current epoch key is stored in prototype — old epochs lost = history inaccessible to new members
    if (epoch !== g.epoch) return null;
    try {
      const plain = decryptGroupMessage(
        { ciphertext: m.ciphertext, nonce: m.nonce },
        {
          groupId,
          epoch: g.epoch,
          key: g.epochKeyHex,
          memberPeerIds: JSON.parse(g.membersJson) as string[],
        },
      );
      store.updateMessageStatus(messageId, "decrypted", plain);
      return plain;
    } catch {
      return null;
    }
  }

  private distributeEpoch(name: string, epochKey: GroupEpochKey): void {
    const payload: GroupEpochPayload = {
      groupId: epochKey.groupId,
      name,
      epoch: epochKey.epoch,
      members: epochKey.memberPeerIds,
      epochKeyHex: epochKey.key,
    };
    const envelope: P2pEnvelope = { v: 1, kind: "group_epoch", payload };
    for (const member of epochKey.memberPeerIds) {
      if (member === this.identity.peerId) continue;
      this.p2p.send(member, envelope);
    }
  }

  private handleEpoch(payload: GroupEpochPayload): void {
    if (!payload.members.includes(this.identity.peerId)) {
      // Removed from group — delete local epoch key
      const existing = store.getGroup(payload.groupId);
      if (existing) {
        store.saveGroup({
          ...existing,
          epoch: payload.epoch,
          membersJson: JSON.stringify(payload.members),
          epochKeyHex: "", // no key for removed member
        });
      }
      this.notify();
      return;
    }
    store.saveGroup({
      groupId: payload.groupId,
      name: payload.name,
      epoch: payload.epoch,
      membersJson: JSON.stringify(payload.members),
      epochKeyHex: payload.epochKeyHex,
      createdAt: Date.now(),
    });
    this.notify();
  }

  private handleChat(_from: string, payload: GroupChatPayload): void {
    const g = store.getGroup(payload.groupId);
    let plaintext: string | null = null;
    if (g && g.epochKeyHex && g.epoch === payload.epoch) {
      try {
        plaintext = decryptGroupMessage(
          { ciphertext: payload.ciphertext, nonce: payload.nonce },
          {
            groupId: payload.groupId,
            epoch: payload.epoch,
            key: g.epochKeyHex,
            memberPeerIds: JSON.parse(g.membersJson) as string[],
          },
        );
      } catch {
        plaintext = null;
      }
    }
    store.saveMessage({
      messageId: payload.messageId,
      conversationId: `group:${payload.groupId}`,
      senderId: payload.senderId,
      ciphertext: payload.ciphertext,
      nonce: payload.nonce,
      messageKeyId: `${payload.groupId}:epoch:${payload.epoch}`,
      createdAt: payload.createdAt,
      deliveryDeadline: payload.deliveryDeadline,
      decryptionDeadline: null,
      retentionDeadline: null,
      status: plaintext ? "decrypted" : "delivered",
      encryptionMetadata: JSON.stringify({ algorithm: "AES-256-GCM", version: 1 }),
      wrappedKey: null,
      securityMode: "normal",
      plaintextCache: plaintext,
    });
    this.notify();
  }

  private handleSync(payload: GroupSyncPayload): void {
    for (const m of payload.messages) {
      const existing = store.listAllMessages().find((x) => x.messageId === m.messageId);
      if (existing) continue;
      this.handleChat("", m);
    }
  }
}
