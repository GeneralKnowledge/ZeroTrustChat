/**
 * Group chats with shared connection pooling + compressed-digest anti-entropy.
 *
 * Messages fan out to a small set of live neighbors (not N−1), then propagate
 * via gossip forward and periodic digest exchange. The central server is never
 * a mailbox — only existing P2P DataChannels (via P2pManager) are used.
 *
 * Prototype crypto: shared AES epoch key per membership change.
 * Production should move to MLS (or similar).
 */

import {
  decryptGroupMessage,
  encryptGroupMessage,
  generateGroupEpochKey,
  signEpochAnnouncement,
  unwrapEpochKeyFromPeer,
  verifyEpochAnnouncement,
  wrapEpochKeyForPeer,
  type GroupEpochKey,
} from "@ztc/crypto";
import type { P2pEnvelope } from "./p2p";
import type { P2pTransport } from "./p2pTransport";
import type { LocalIdentity, StoredMessage } from "./store";
import type { ChatStore } from "./memoryStore";
import { defaultChatStore } from "./defaultStore";
import {
  buildGroupDigest,
  computeOffers,
  computeWants,
  HAVE_BATCH_LIMIT,
  indexKey,
  type GroupDigest,
  type IndexedGroupMessage,
  type SeqNeed,
} from "./groupDigest";
import {
  buildGroupsByPeer,
  DEFAULT_FANOUT,
  DEFAULT_MAX_DEGREE,
  pickFanoutTargets,
  pickPeersToDial,
  preferredHelpersForGroup,
  rankPeersForPool,
} from "./groupTopology";
import { encodeAppMessage, parseAppMessage, type AppMessage } from "./appMessage";

export interface GroupChatPayload {
  groupId: string;
  epoch: number;
  messageId: string;
  senderId: string;
  /** Per-install device — namespaces senderSeq for multi-device same identity. */
  senderDeviceId: string;
  /** Per-sender monotonic sequence for compressed digests / gap repair. */
  senderSeq: number;
  ciphertext: string;
  nonce: string;
  createdAt: number;
  deliveryDeadline: number | null;
}

export interface GroupEpochPayload {
  groupId: string;
  name: string;
  epoch: number;
  prevEpoch: number;
  members: string[];
  epochId: string;
  changerId: string;
  /** Per-member wrapped epoch key (preferred). */
  wraps: Record<string, string>;
  signingPublicKey: string;
  signature: string;
  /** Legacy plaintext key — only for older peers; omit when wraps present. */
  epochKeyHex?: string;
}

export interface GroupCapabilityPayload {
  canHelper: boolean;
  updatedAt: number;
}

export interface GroupSyncPayload {
  groupId: string;
  messages: GroupChatPayload[];
}

export interface GroupWantPayload {
  groupId: string;
  needs: SeqNeed[];
}

export interface GroupHavePayload {
  groupId: string;
  messages: GroupChatPayload[];
}

export interface GroupSyncStatus {
  groupId: string;
  local: number;
  estimate: number;
  syncing: boolean;
  connectedMembers: number;
  poolSize: number;
}

const ANTI_ENTROPY_MS = 8_000;
const TIME_BUCKET_MS = 10 * 60 * 1000;

export class GroupService {
  private readonly p2p: P2pTransport;
  private readonly identity: LocalIdentity;
  private readonly store: ChatStore;
  private listeners = new Set<() => void>();
  private antiEntropyTimer: ReturnType<typeof setInterval> | null = null;
  /** messageId → already forwarded (storm control) */
  private forwarded = new Set<string>();
  /** groupId → max messageCount advertised by any neighbor */
  private neighborEstimates = new Map<string, number>();
  private syncingGroups = new Set<string>();
  /** Soft helpers learned from capability ads on existing edges only. */
  private helperPeers = new Set<string>();

  constructor(
    p2p: P2pTransport,
    identity: LocalIdentity,
    chatStore: ChatStore = defaultChatStore,
  ) {
    this.p2p = p2p;
    this.identity = identity;
    this.store = chatStore;
    p2p.onData((from, env) => {
      if (env.kind === "group_epoch") this.handleEpoch(from, env.payload as GroupEpochPayload);
      if (env.kind === "group_chat") this.handleChat(from, env.payload as GroupChatPayload, true);
      if (env.kind === "group_sync") this.handleSync(env.payload as GroupSyncPayload);
      if (env.kind === "group_digest") this.handleDigest(from, env.payload as GroupDigest);
      if (env.kind === "group_want") this.handleWant(from, env.payload as GroupWantPayload);
      if (env.kind === "group_have") this.handleHave(env.payload as GroupHavePayload);
      if (env.kind === "group_capability") {
        this.handleCapability(from, env.payload as GroupCapabilityPayload);
      }
    });
    p2p.onState((peerId, state) => {
      if (state === "connected") {
        this.syncMissedTo(peerId);
        this.sendDigestsTo(peerId);
        this.sendCapabilityTo(peerId);
      }
    });
  }

  start(): void {
    if (this.antiEntropyTimer) return;
    this.antiEntropyTimer = setInterval(() => {
      void this.ensureTopology();
      this.runAntiEntropy();
    }, ANTI_ENTROPY_MS);
    void this.ensureTopology();
  }

  stop(): void {
    if (this.antiEntropyTimer) clearInterval(this.antiEntropyTimer);
    this.antiEntropyTimer = null;
  }

  /** Simulation/test hook: one topology + anti-entropy round. */
  async tickAntiEntropy(): Promise<void> {
    await this.ensureTopology();
    this.runAntiEntropy();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  /** Shared pool: dial high-value peers across all groups within degree budget. */
  async ensureTopology(): Promise<void> {
    const bucket = Math.floor(Date.now() / TIME_BUCKET_MS);
    const groups = this.store.listGroups().map((g) => ({
      groupId: g.groupId,
      members: JSON.parse(g.membersJson) as string[],
      epoch: g.epoch,
    }));
    const groupsByPeer = buildGroupsByPeer(
      this.identity.peerId,
      groups.map((g) => ({ groupId: g.groupId, members: g.members })),
    );
    const candidates = [...groupsByPeer.keys()];
    const preferred = new Set<string>();
    for (const g of groups) {
      for (const h of preferredHelpersForGroup(g.groupId, g.members, g.epoch, bucket, 2)) {
        if (h !== this.identity.peerId) preferred.add(h);
      }
    }
    const connected = new Set(this.p2p.listConnectedPeers());
    const connecting = new Set(this.p2p.listConnectingPeers());
    const ranked = rankPeersForPool({
      localPeerId: this.identity.peerId,
      candidates,
      groupsByPeer,
      connected,
      helperPeers: this.helperPeers,
      preferredHelpers: preferred,
      timeBucket: bucket,
    });
    const toDial = pickPeersToDial(ranked, connected, connecting, DEFAULT_MAX_DEGREE);
    if (toDial.length > 0) {
      await this.p2p.ensureConnections(toDial, DEFAULT_MAX_DEGREE);
    }
  }

  getSyncStatus(groupId: string): GroupSyncStatus {
    const local = this.indexGroupMessages(groupId).length;
    const estimate = Math.max(local, this.neighborEstimates.get(groupId) ?? local);
    const g = this.store.getGroup(groupId);
    const members = g ? (JSON.parse(g.membersJson) as string[]) : [];
    const connectedMembers = members.filter(
      (m) => m !== this.identity.peerId && this.p2p.isConnected(m),
    ).length;
    return {
      groupId,
      local,
      estimate,
      syncing: this.syncingGroups.has(groupId) || estimate > local,
      connectedMembers,
      poolSize: this.p2p.listConnectedPeers().length,
    };
  }

  createGroup(name: string, memberPeerIds: string[]): string {
    const groupId = crypto.randomUUID();
    const members = Array.from(new Set([this.identity.peerId, ...memberPeerIds])).sort();
    const epochKey = generateGroupEpochKey(groupId, 1, members);
    this.store.saveGroup({
      groupId,
      name,
      epoch: 1,
      membersJson: JSON.stringify(members),
      epochKeyHex: epochKey.key,
      createdAt: Date.now(),
    });
    this.distributeEpoch(name, epochKey);
    void this.ensureTopology();
    this.notify();
    return groupId;
  }

  /** Membership change → new epoch. Removed members do not receive new key. */
  updateMembership(groupId: string, newMemberPeerIds: string[]): void {
    const g = this.store.getGroup(groupId);
    if (!g) throw new Error("Group not found");
    const members = Array.from(new Set([this.identity.peerId, ...newMemberPeerIds])).sort();
    const epoch = g.epoch + 1;
    const epochKey = generateGroupEpochKey(groupId, epoch, members);
    this.store.saveGroup({
      ...g,
      epoch,
      membersJson: JSON.stringify(members),
      epochKeyHex: epochKey.key,
    });
    this.distributeEpoch(g.name, epochKey);
    void this.ensureTopology();
    this.notify();
  }

  sendGroupMessage(groupId: string, plaintext: string, deliveryDeadlineMs?: number): string {
    return this.sendGroupApp(groupId, { v: 1, type: "text", body: plaintext }, deliveryDeadlineMs);
  }

  sendGroupReply(
    groupId: string,
    body: string,
    replyTo: string,
    deliveryDeadlineMs?: number,
  ): string {
    return this.sendGroupApp(
      groupId,
      { v: 1, type: "text", body, replyTo },
      deliveryDeadlineMs,
    );
  }

  sendGroupReaction(groupId: string, targetId: string, emoji: string): string {
    const mine = this.store.listReactions(targetId).find((r) => r.reactorId === this.identity.peerId);
    const op = mine?.emoji === emoji ? "clear" : "set";
    this.store.applyReaction(targetId, this.identity.peerId, emoji, op);
    return this.sendGroupApp(groupId, { v: 1, type: "reaction", targetId, emoji, op });
  }

  sendGroupDelete(groupId: string, targetId: string): string {
    const target = this.store.getMessage(targetId);
    if (!target || target.senderId !== this.identity.peerId) {
      throw new Error("Can only delete your own messages");
    }
    this.store.markMessageDeleted(targetId);
    return this.sendGroupApp(groupId, { v: 1, type: "delete", targetId });
  }

  sendGroupEdit(groupId: string, targetId: string, body: string): string {
    if (!this.store.applyMessageEdit(targetId, this.identity.peerId, body)) {
      throw new Error("Can only edit your own messages");
    }
    return this.sendGroupApp(groupId, { v: 1, type: "edit", targetId, body });
  }

  sendGroupPin(groupId: string, targetId: string): string {
    const conversationId = `group:${groupId}`;
    const pinned = this.store.isPinned(conversationId, targetId);
    const op = pinned ? "clear" : "set";
    this.store.applyPin(conversationId, targetId, this.identity.peerId, op);
    return this.sendGroupApp(groupId, { v: 1, type: "pin", targetId, op });
  }

  private sendGroupApp(
    groupId: string,
    app: AppMessage,
    deliveryDeadlineMs?: number,
  ): string {
    const g = this.store.getGroup(groupId);
    if (!g) throw new Error("Group not found");
    const members = JSON.parse(g.membersJson) as string[];
    if (!members.includes(this.identity.peerId)) throw new Error("Not a member");

    const plaintext = encodeAppMessage(app);
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
    const senderSeq = this.nextSenderSeq(groupId);
    const senderDeviceId = this.identity.deviceId;

    const payload: GroupChatPayload = {
      groupId,
      epoch: g.epoch,
      messageId,
      senderId: this.identity.peerId,
      senderDeviceId,
      senderSeq,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      createdAt: now,
      deliveryDeadline,
    };

    this.store.saveMessage({
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
      encryptionMetadata: JSON.stringify({
        algorithm: "AES-256-GCM",
        version: 1,
        senderSeq,
        senderDeviceId,
      }),
      wrappedKey: null,
      securityMode: "normal",
      plaintextCache: plaintext,
    });

    this.forwarded.add(messageId);
    this.gossipToNeighbors(groupId, members, payload, new Set([this.identity.peerId]));
    void this.ensureTopology();
    this.notify();
    return messageId;
  }

  /** Device-to-device sync of recent group ciphertext to a reconnecting member. */
  syncMissedTo(peerId: string): void {
    for (const g of this.store.listGroups()) {
      const members = JSON.parse(g.membersJson) as string[];
      if (!members.includes(peerId)) continue;
      const msgs = this.recentPayloads(g.groupId, 50);
      if (msgs.length === 0) continue;
      this.p2p.send(peerId, {
        v: 1,
        kind: "group_sync",
        payload: { groupId: g.groupId, messages: msgs } satisfies GroupSyncPayload,
      });
    }
  }

  decryptStoredGroupMessage(messageId: string): string | null {
    const m = this.store.listAllMessages().find((x) => x.messageId === messageId);
    if (!m || !m.conversationId.startsWith("group:")) return null;
    if (m.plaintextCache) return m.plaintextCache;
    const groupId = m.conversationId.slice("group:".length);
    const g = this.store.getGroup(groupId);
    if (!g) return null;
    const epoch = Number(m.messageKeyId.split(":epoch:")[1] ?? g.epoch);
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
      this.store.updateMessageStatus(messageId, "decrypted", plain);
      return plain;
    } catch {
      return null;
    }
  }

  private distributeEpoch(name: string, epochKey: GroupEpochKey): void {
    const prevEpoch = Math.max(0, epochKey.epoch - 1);
    const epochId = crypto.randomUUID();
    const fields = {
      groupId: epochKey.groupId,
      name,
      epoch: epochKey.epoch,
      prevEpoch,
      members: epochKey.memberPeerIds,
      epochId,
      changerId: this.identity.peerId,
    };
    const wraps: Record<string, string> = {};
    for (const member of epochKey.memberPeerIds) {
      const contact = this.store.listContacts().find((c) => c.peerId === member);
      const recipientPub =
        member === this.identity.peerId ? this.identity.publicKey : contact?.publicKey;
      if (!recipientPub) continue;
      wraps[member] = wrapEpochKeyForPeer(
        epochKey.key,
        this.identity.privateKey,
        recipientPub,
      );
    }
    // Always wrap for self
    wraps[this.identity.peerId] = wrapEpochKeyForPeer(
      epochKey.key,
      this.identity.privateKey,
      this.identity.publicKey,
    );

    const payload: GroupEpochPayload = {
      ...fields,
      wraps,
      signingPublicKey: this.identity.signingPublicKey,
      signature: signEpochAnnouncement(fields, this.identity.signingPrivateKey),
    };
    const envelope: P2pEnvelope = { v: 1, kind: "group_epoch", payload };
    const connected = epochKey.memberPeerIds.filter(
      (m) => m !== this.identity.peerId && this.p2p.isConnected(m),
    );
    for (const member of connected) {
      this.p2p.send(member, envelope);
    }
    if (connected.length === 0) {
      const ranked = this.rankMembers(epochKey.memberPeerIds).slice(0, DEFAULT_FANOUT);
      const now = Date.now();
      for (const member of ranked) {
        this.store.enqueueOutbox(
          `epoch:${epochKey.groupId}:${epochKey.epoch}:${member}`,
          member,
          JSON.stringify(envelope),
          now,
          null,
          null,
        );
      }
    }
  }

  private handleEpoch(_from: string, payload: GroupEpochPayload): void {
    const fields = {
      groupId: payload.groupId,
      name: payload.name,
      epoch: payload.epoch,
      prevEpoch: payload.prevEpoch ?? payload.epoch - 1,
      members: payload.members,
      epochId: payload.epochId ?? `${payload.groupId}:${payload.epoch}`,
      changerId: payload.changerId ?? _from,
    };

    // Signed epochs preferred; accept legacy unsigned only if epochKeyHex present and no signature.
    if (payload.signature && payload.signingPublicKey) {
      if (!verifyEpochAnnouncement(fields, payload.signature, payload.signingPublicKey)) {
        return;
      }
      const contact = this.store.listContacts().find((c) => c.peerId === fields.changerId);
      if (contact?.signingPublicKey && contact.signingPublicKey !== payload.signingPublicKey) {
        return;
      }
      if (contact && !contact.signingPublicKey) {
        this.store.upsertContact({ ...contact, signingPublicKey: payload.signingPublicKey });
      }
    } else if (!payload.epochKeyHex) {
      return;
    }

    if (!payload.members.includes(this.identity.peerId)) {
      const existing = this.store.getGroup(payload.groupId);
      if (existing) {
        this.store.saveGroup({
          ...existing,
          epoch: payload.epoch,
          membersJson: JSON.stringify(payload.members),
          epochKeyHex: "",
        });
      }
      this.notify();
      return;
    }

    const existing = this.store.getGroup(payload.groupId);
    if (existing && existing.epoch > payload.epoch) return;

    let epochKeyHex = "";
    if (payload.wraps?.[this.identity.peerId]) {
      try {
        const senderPub =
          this.store.listContacts().find((c) => c.peerId === fields.changerId)?.publicKey ??
          (fields.changerId === this.identity.peerId ? this.identity.publicKey : null);
        if (senderPub) {
          epochKeyHex = unwrapEpochKeyFromPeer(
            payload.wraps[this.identity.peerId]!,
            this.identity.privateKey,
            senderPub,
          );
        }
      } catch {
        epochKeyHex = "";
      }
    } else if (payload.epochKeyHex) {
      epochKeyHex = payload.epochKeyHex;
    }

    this.store.saveGroup({
      groupId: payload.groupId,
      name: payload.name,
      epoch: payload.epoch,
      membersJson: JSON.stringify(payload.members),
      epochKeyHex,
      createdAt: existing?.createdAt ?? Date.now(),
    });
    this.notify();
  }

  private handleChat(from: string, payload: GroupChatPayload, shouldForward: boolean): void {
    const existing = this.store.listAllMessages().find((x) => x.messageId === payload.messageId);
    if (existing) {
      // Still allow digest repair paths; do not re-forward duplicates.
      return;
    }

    const g = this.store.getGroup(payload.groupId);
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

    const senderSeq = payload.senderSeq ?? 0;
    const senderDeviceId = payload.senderDeviceId ?? payload.senderId;
    this.store.saveMessage({
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
      encryptionMetadata: JSON.stringify({
        algorithm: "AES-256-GCM",
        version: 1,
        senderSeq,
        senderDeviceId,
      }),
      wrappedKey: null,
      securityMode: "normal",
      plaintextCache: plaintext,
    });

    if (plaintext) {
      const app = parseAppMessage(plaintext);
      if (app.type === "reaction") {
        this.store.applyReaction(app.targetId, payload.senderId, app.emoji, app.op);
      } else if (app.type === "delete") {
        const target = this.store.getMessage(app.targetId);
        if (target && target.senderId === payload.senderId) {
          this.store.markMessageDeleted(app.targetId);
        }
      } else if (app.type === "edit") {
        this.store.applyMessageEdit(app.targetId, payload.senderId, app.body);
      } else if (app.type === "pin") {
        this.store.applyPin(`group:${payload.groupId}`, app.targetId, payload.senderId, app.op);
      }
    }

    if (shouldForward && !this.forwarded.has(payload.messageId)) {
      this.forwarded.add(payload.messageId);
      const members = g ? (JSON.parse(g.membersJson) as string[]) : [];
      this.gossipToNeighbors(
        payload.groupId,
        members,
        { ...payload, senderSeq, senderDeviceId },
        new Set([from, this.identity.peerId, payload.senderId]),
      );
    }
    this.notify();
  }

  private handleSync(payload: GroupSyncPayload): void {
    for (const m of payload.messages) {
      this.handleChat("", m, false);
    }
  }

  private handleDigest(from: string, remote: GroupDigest): void {
    const g = this.store.getGroup(remote.groupId);
    if (!g) return;
    const members = JSON.parse(g.membersJson) as string[];
    if (!members.includes(from)) return;

    const prev = this.neighborEstimates.get(remote.groupId) ?? 0;
    if (remote.messageCount > prev) {
      this.neighborEstimates.set(remote.groupId, remote.messageCount);
    }

    // Push newer epoch if we are ahead
    if (g.epoch > remote.epoch && g.epochKeyHex) {
      this.distributeEpoch(g.name, {
        groupId: g.groupId,
        epoch: g.epoch,
        key: g.epochKeyHex,
        memberPeerIds: members,
      });
    }

    const local = this.indexGroupMessages(remote.groupId);
    const wants = computeWants(local, remote);
    if (wants.length > 0) {
      this.syncingGroups.add(remote.groupId);
      this.p2p.send(from, {
        v: 1,
        kind: "group_want",
        payload: { groupId: remote.groupId, needs: wants } satisfies GroupWantPayload,
      });
    } else {
      this.syncingGroups.delete(remote.groupId);
    }

    // Opportunistically push what they are missing (speeds convergence; not deliberate delay)
    const offers = computeOffers(local, remote);
    if (offers.length > 0) {
      const messages = this.payloadsForNeeds(remote.groupId, offers);
      if (messages.length > 0) {
        this.p2p.send(from, {
          v: 1,
          kind: "group_have",
          payload: { groupId: remote.groupId, messages } satisfies GroupHavePayload,
        });
      }
    }
    this.notify();
  }

  private handleWant(from: string, want: GroupWantPayload): void {
    const messages = this.payloadsForNeeds(want.groupId, want.needs).slice(0, HAVE_BATCH_LIMIT);
    if (messages.length === 0) return;
    this.p2p.send(from, {
      v: 1,
      kind: "group_have",
      payload: { groupId: want.groupId, messages } satisfies GroupHavePayload,
    });
  }

  private handleHave(payload: GroupHavePayload): void {
    for (const m of payload.messages) {
      this.handleChat("", m, true);
    }
    const local = this.indexGroupMessages(payload.groupId).length;
    const est = this.neighborEstimates.get(payload.groupId) ?? local;
    if (local >= est) this.syncingGroups.delete(payload.groupId);
    this.notify();
  }

  private runAntiEntropy(): void {
    for (const g of this.store.listGroups()) {
      const members = JSON.parse(g.membersJson) as string[];
      const connected = members.filter(
        (m) => m !== this.identity.peerId && this.p2p.isConnected(m),
      );
      if (connected.length === 0) continue;
      const digest = buildGroupDigest(g.groupId, g.epoch, this.indexGroupMessages(g.groupId));
      const digestEnv: P2pEnvelope = { v: 1, kind: "group_digest", payload: digest };
      const capEnv: P2pEnvelope = {
        v: 1,
        kind: "group_capability",
        payload: this.localCapability() satisfies GroupCapabilityPayload,
      };
      for (const peer of pickFanoutTargets(connected)) {
        this.p2p.send(peer, digestEnv);
        this.p2p.send(peer, capEnv);
      }
    }
  }

  private sendDigestsTo(peerId: string): void {
    for (const g of this.store.listGroups()) {
      const members = JSON.parse(g.membersJson) as string[];
      if (!members.includes(peerId)) continue;
      const digest = buildGroupDigest(g.groupId, g.epoch, this.indexGroupMessages(g.groupId));
      this.p2p.send(peerId, { v: 1, kind: "group_digest", payload: digest });
    }
  }

  private sendCapabilityTo(peerId: string): void {
    this.p2p.send(peerId, {
      v: 1,
      kind: "group_capability",
      payload: this.localCapability() satisfies GroupCapabilityPayload,
    });
  }

  private handleCapability(from: string, payload: GroupCapabilityPayload): void {
    if (payload.canHelper) this.helperPeers.add(from);
    else this.helperPeers.delete(from);
  }

  /** Desktop / non-metered prototype default: willing to help within pool budget. */
  private localCapability(): GroupCapabilityPayload {
    return { canHelper: true, updatedAt: Date.now() };
  }

  private gossipToNeighbors(
    _groupId: string,
    members: string[],
    payload: GroupChatPayload,
    except: ReadonlySet<string>,
  ): void {
    const connectedMembers = members.filter((m) => this.p2p.isConnected(m));
    const targets = pickFanoutTargets(connectedMembers, except, DEFAULT_FANOUT);
    const envelope: P2pEnvelope = { v: 1, kind: "group_chat", payload };
    const now = Date.now();

    if (targets.length === 0) {
      // Nobody live — enqueue for top pool candidates so reconnect delivers fast
      const ranked = this.rankMembers(members).filter((m) => !except.has(m)).slice(0, DEFAULT_FANOUT);
      for (const member of ranked) {
        this.store.enqueueOutbox(
          `${payload.messageId}:${member}`,
          member,
          JSON.stringify(envelope),
          now,
          payload.deliveryDeadline,
          payload.deliveryDeadline,
        );
      }
      return;
    }

    for (const member of targets) {
      if (!this.p2p.send(member, envelope)) {
        this.store.enqueueOutbox(
          `${payload.messageId}:${member}`,
          member,
          JSON.stringify(envelope),
          now,
          payload.deliveryDeadline,
          payload.deliveryDeadline,
        );
      }
    }
  }

  private rankMembers(members: string[]): string[] {
    const groups = this.store.listGroups().map((g) => ({
      groupId: g.groupId,
      members: JSON.parse(g.membersJson) as string[],
    }));
    return rankPeersForPool({
      localPeerId: this.identity.peerId,
      candidates: members.filter((m) => m !== this.identity.peerId),
      groupsByPeer: buildGroupsByPeer(this.identity.peerId, groups),
      connected: new Set(this.p2p.listConnectedPeers()),
      helperPeers: this.helperPeers,
      timeBucket: Math.floor(Date.now() / TIME_BUCKET_MS),
    });
  }

  private nextSenderSeq(groupId: string): number {
    let max = 0;
    for (const m of this.store.listMessages(`group:${groupId}`)) {
      if (m.senderId !== this.identity.peerId) continue;
      const meta = readMeta(m);
      if (meta.senderDeviceId && meta.senderDeviceId !== this.identity.deviceId) continue;
      if (meta.senderSeq > max) max = meta.senderSeq;
    }
    return max + 1;
  }

  private indexGroupMessages(groupId: string): IndexedGroupMessage[] {
    return this.store
      .listMessages(`group:${groupId}`)
      .filter((m) => m.status !== "expired")
      .map((m) => {
        const meta = readMeta(m);
        const device = meta.senderDeviceId || m.senderId;
        return {
          messageId: m.messageId,
          // Device-scoped digest key so multi-device same identity does not clash seqs
          senderId: `${m.senderId}/${device}`,
          senderSeq: meta.senderSeq,
          epoch: Number(m.messageKeyId.split(":epoch:")[1] ?? 0),
        };
      });
  }

  private recentPayloads(groupId: string, limit: number): GroupChatPayload[] {
    const g = this.store.getGroup(groupId);
    if (!g) return [];
    return this.store
      .listMessages(`group:${groupId}`)
      .filter((m) => m.status !== "expired")
      .slice(-limit)
      .map((m) => storedToPayload(m, g.groupId, g.epoch));
  }

  private payloadsForNeeds(groupId: string, needs: SeqNeed[]): GroupChatPayload[] {
    const g = this.store.getGroup(groupId);
    if (!g) return [];
    const want = new Set(needs.map((n) => indexKey(n.senderId, n.seq)));
    const out: GroupChatPayload[] = [];
    for (const m of this.store.listMessages(`group:${groupId}`)) {
      if (m.status === "expired") continue;
      const meta = readMeta(m);
      const device = meta.senderDeviceId || m.senderId;
      const digestSender = `${m.senderId}/${device}`;
      if (!want.has(indexKey(digestSender, meta.senderSeq))) continue;
      out.push(storedToPayload(m, g.groupId, g.epoch));
      if (out.length >= HAVE_BATCH_LIMIT) break;
    }
    return out;
  }
}

function readMeta(m: StoredMessage): { senderSeq: number; senderDeviceId: string } {
  try {
    const meta = JSON.parse(m.encryptionMetadata) as {
      senderSeq?: number;
      senderDeviceId?: string;
    };
    return {
      senderSeq: typeof meta.senderSeq === "number" ? meta.senderSeq : 0,
      senderDeviceId: typeof meta.senderDeviceId === "string" ? meta.senderDeviceId : "",
    };
  } catch {
    return { senderSeq: 0, senderDeviceId: "" };
  }
}

function storedToPayload(m: StoredMessage, groupId: string, fallbackEpoch: number): GroupChatPayload {
  const meta = readMeta(m);
  return {
    groupId,
    epoch: Number(m.messageKeyId.split(":epoch:")[1] ?? fallbackEpoch),
    messageId: m.messageId,
    senderId: m.senderId,
    senderDeviceId: meta.senderDeviceId || m.senderId,
    senderSeq: meta.senderSeq,
    ciphertext: m.ciphertext,
    nonce: m.nonce,
    createdAt: m.createdAt,
    deliveryDeadline: m.deliveryDeadline,
  };
}
