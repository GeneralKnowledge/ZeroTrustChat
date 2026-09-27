/**
 * Shared helpers for FakeP2P multi-peer simulation tests.
 */

import { generateIdentity } from "@ztc/crypto";
import type { LocalIdentity } from "../store";
import { MemoryStore } from "../memoryStore";
import { MessagingService } from "../messaging";
import { GroupService } from "../groups";
import { FakeP2pEndpoint, FakeP2pHub } from "./fakeP2p";

export interface SimPeer {
  name: string;
  identity: LocalIdentity;
  store: MemoryStore;
  p2p: FakeP2pEndpoint;
  messaging: MessagingService;
  groups: GroupService;
}

export function makeIdentity(displayName?: string): LocalIdentity {
  const id = generateIdentity();
  return {
    ...id,
    displayName: displayName ?? id.displayName,
    deviceId: crypto.randomUUID(),
  };
}

export function createSimPeer(hub: FakeP2pHub, name: string, identity?: LocalIdentity): SimPeer {
  const id = identity ?? makeIdentity(name);
  const store = new MemoryStore();
  store.saveIdentity(id);
  const p2p = hub.createEndpoint(id.peerId);
  const messaging = new MessagingService(p2p, id, store);
  const groups = new GroupService(p2p, id, store);
  return { name, identity: id, store, p2p, messaging, groups };
}

/** Register mutual contacts (required for key wrap / epoch verify). */
export function linkContacts(peers: SimPeer[]): void {
  for (const a of peers) {
    for (const b of peers) {
      if (a.identity.peerId === b.identity.peerId) continue;
      a.store.upsertContact({
        peerId: b.identity.peerId,
        publicKey: b.identity.publicKey,
        displayName: b.identity.displayName,
        invitationCode: "",
        addedAt: Date.now(),
        signingPublicKey: b.identity.signingPublicKey,
      });
    }
  }
}

export async function advanceAntiEntropy(peers: SimPeer[], rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(peers.map((p) => p.groups.tickAntiEntropy()));
  }
}

export function groupMessageIds(peer: SimPeer, groupId: string): Set<string> {
  return new Set(
    peer.store
      .listMessages(`group:${groupId}`)
      .filter((m) => m.status !== "expired" && m.status !== "deleted")
      .map((m) => m.messageId),
  );
}

export function textBodies(peer: SimPeer, conversationId: string): string[] {
  return peer.store
    .listMessages(conversationId)
    .filter((m) => m.plaintextCache && m.status !== "deleted")
    .map((m) => {
      try {
        const p = JSON.parse(m.plaintextCache!) as { type?: string; body?: string };
        if (p.type === "text" && typeof p.body === "string") return p.body;
      } catch {
        // legacy
      }
      return m.plaintextCache ?? "";
    });
}
