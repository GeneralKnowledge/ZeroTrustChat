/**
 * In-memory ChatStore for multi-peer simulation tests.
 * Mirrors the semantics of store.ts without sql.js / localStorage.
 */

import type { MessageStatus, SecurityMode } from "@ztc/shared";
import type {
  Contact,
  GroupRow,
  LocalIdentity,
  MessageKeyRow,
  StoredMessage,
} from "./store";

export interface ChatStore {
  saveMessage(m: StoredMessage): void;
  listMessages(conversationId: string): StoredMessage[];
  listAllMessages(): StoredMessage[];
  updateMessageStatus(messageId: string, status: MessageStatus, plaintextCache?: string | null): void;
  getMessage(messageId: string): StoredMessage | null;
  saveMessageKey(k: MessageKeyRow): void;
  getMessageKey(messageKeyId: string): MessageKeyRow | null;
  destroyStoredMessageKey(messageKeyId: string): void;
  deleteExpiredMessages(now?: number): number;
  enqueueOutbox(
    messageId: string,
    recipientPeerId: string,
    payloadJson: string,
    createdAt: number,
    deliveryDeadline: number | null,
    retentionDeadline: number | null,
  ): void;
  listOutbox(now?: number): Array<{
    messageId: string;
    recipientPeerId: string;
    payloadJson: string;
    createdAt: number;
    deliveryDeadline: number | null;
    retentionDeadline: number | null;
  }>;
  removeOutbox(messageId: string): void;
  applyReaction(messageId: string, reactorId: string, emoji: string, op?: "set" | "clear"): void;
  listReactions(messageId: string): Array<{ reactorId: string; emoji: string }>;
  markMessageDeleted(messageId: string): void;
  applyMessageEdit(messageId: string, editorId: string, body: string): boolean;
  applyPin(conversationId: string, messageId: string, pinnedBy: string, op: "set" | "clear"): void;
  isPinned(conversationId: string, messageId: string): boolean;
  listPins(conversationId: string): Array<{ messageId: string; pinnedBy: string; pinnedAt: number }>;
  saveGroup(g: GroupRow): void;
  listGroups(): GroupRow[];
  getGroup(groupId: string): GroupRow | null;
  listContacts(): Contact[];
  upsertContact(c: Contact): void;
  getIdentity(): LocalIdentity | null;
  saveIdentity(id: LocalIdentity): void;
}

type OutboxRow = {
  messageId: string;
  recipientPeerId: string;
  payloadJson: string;
  createdAt: number;
  deliveryDeadline: number | null;
  retentionDeadline: number | null;
};

export class MemoryStore implements ChatStore {
  private identity: LocalIdentity | null = null;
  private contacts = new Map<string, Contact>();
  private messages = new Map<string, StoredMessage>();
  private keys = new Map<string, MessageKeyRow>();
  private outbox = new Map<string, OutboxRow>();
  private groups = new Map<string, GroupRow>();
  private reactions = new Map<string, Map<string, string>>(); // messageId -> reactorId -> emoji
  private pins = new Map<string, Map<string, { pinnedBy: string; pinnedAt: number }>>(); // conv -> msg -> meta

  saveIdentity(id: LocalIdentity): void {
    this.identity = { ...id };
  }

  getIdentity(): LocalIdentity | null {
    return this.identity ? { ...this.identity } : null;
  }

  upsertContact(c: Contact): void {
    this.contacts.set(c.peerId, { ...c });
  }

  listContacts(): Contact[] {
    return [...this.contacts.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  saveMessage(m: StoredMessage): void {
    this.messages.set(m.messageId, { ...m });
  }

  listMessages(conversationId: string): StoredMessage[] {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => ({ ...m }));
  }

  listAllMessages(): StoredMessage[] {
    return [...this.messages.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => ({ ...m }));
  }

  getMessage(messageId: string): StoredMessage | null {
    const m = this.messages.get(messageId);
    return m ? { ...m } : null;
  }

  updateMessageStatus(
    messageId: string,
    status: MessageStatus,
    plaintextCache?: string | null,
  ): void {
    const m = this.messages.get(messageId);
    if (!m) return;
    m.status = status;
    if (plaintextCache !== undefined) m.plaintextCache = plaintextCache;
  }

  saveMessageKey(k: MessageKeyRow): void {
    this.keys.set(k.messageKeyId, { ...k });
  }

  getMessageKey(messageKeyId: string): MessageKeyRow | null {
    const k = this.keys.get(messageKeyId);
    return k ? { ...k } : null;
  }

  destroyStoredMessageKey(messageKeyId: string): void {
    const k = this.keys.get(messageKeyId);
    if (k) {
      k.destroyed = 1;
      k.keyHex = "";
    }
  }

  deleteExpiredMessages(now = Date.now()): number {
    let n = 0;
    for (const [id, m] of this.messages) {
      if (m.retentionDeadline != null && m.retentionDeadline <= now) {
        this.messages.delete(id);
        n++;
      }
    }
    for (const [id, o] of this.outbox) {
      if (o.deliveryDeadline != null && o.deliveryDeadline <= now) {
        this.outbox.delete(id);
      }
    }
    return n;
  }

  enqueueOutbox(
    messageId: string,
    recipientPeerId: string,
    payloadJson: string,
    createdAt: number,
    deliveryDeadline: number | null,
    retentionDeadline: number | null,
  ): void {
    this.outbox.set(messageId, {
      messageId,
      recipientPeerId,
      payloadJson,
      createdAt,
      deliveryDeadline,
      retentionDeadline,
    });
  }

  listOutbox(now = Date.now()): OutboxRow[] {
    return [...this.outbox.values()].filter(
      (o) => o.deliveryDeadline == null || o.deliveryDeadline > now,
    );
  }

  removeOutbox(messageId: string): void {
    this.outbox.delete(messageId);
  }

  applyReaction(
    messageId: string,
    reactorId: string,
    emoji: string,
    op: "set" | "clear" = "set",
  ): void {
    let map = this.reactions.get(messageId);
    if (!map) {
      map = new Map();
      this.reactions.set(messageId, map);
    }
    if (op === "clear") map.delete(reactorId);
    else map.set(reactorId, emoji);
  }

  listReactions(messageId: string): Array<{ reactorId: string; emoji: string }> {
    const map = this.reactions.get(messageId);
    if (!map) return [];
    return [...map.entries()].map(([reactorId, emoji]) => ({ reactorId, emoji }));
  }

  markMessageDeleted(messageId: string): void {
    const m = this.messages.get(messageId);
    if (!m) return;
    m.status = "deleted";
    m.plaintextCache = null;
  }

  applyMessageEdit(messageId: string, editorId: string, body: string): boolean {
    const m = this.messages.get(messageId);
    if (!m || m.senderId !== editorId || m.status === "deleted") return false;
    let replyTo: string | undefined;
    if (m.plaintextCache) {
      try {
        const p = JSON.parse(m.plaintextCache) as { type?: string; replyTo?: string };
        if (p.type === "text" && typeof p.replyTo === "string") replyTo = p.replyTo;
      } catch {
        // ignore
      }
    }
    m.plaintextCache = JSON.stringify(
      replyTo ? { v: 1, type: "text", body, replyTo } : { v: 1, type: "text", body },
    );
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(m.encryptionMetadata) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    meta.edited = true;
    meta.editedAt = Date.now();
    m.encryptionMetadata = JSON.stringify(meta);
    return true;
  }

  applyPin(
    conversationId: string,
    messageId: string,
    pinnedBy: string,
    op: "set" | "clear",
  ): void {
    let map = this.pins.get(conversationId);
    if (!map) {
      map = new Map();
      this.pins.set(conversationId, map);
    }
    if (op === "clear") map.delete(messageId);
    else map.set(messageId, { pinnedBy, pinnedAt: Date.now() });
  }

  isPinned(conversationId: string, messageId: string): boolean {
    return this.pins.get(conversationId)?.has(messageId) ?? false;
  }

  listPins(conversationId: string): Array<{ messageId: string; pinnedBy: string; pinnedAt: number }> {
    const map = this.pins.get(conversationId);
    if (!map) return [];
    return [...map.entries()]
      .map(([messageId, meta]) => ({ messageId, ...meta }))
      .sort((a, b) => b.pinnedAt - a.pinnedAt);
  }

  saveGroup(g: GroupRow): void {
    this.groups.set(g.groupId, { ...g });
  }

  listGroups(): GroupRow[] {
    return [...this.groups.values()].map((g) => ({ ...g }));
  }

  getGroup(groupId: string): GroupRow | null {
    const g = this.groups.get(groupId);
    return g ? { ...g } : null;
  }
}

/** Unused param keep for SecurityMode import usage in consumers. */
export type _SecurityMode = SecurityMode;
