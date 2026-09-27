/**
 * In-memory P2P mesh for deterministic multi-peer simulation.
 * Implements P2pTransport — no WebRTC, no ServerInterface.
 */

import type { P2pEnvelope, P2pState } from "../p2p";
import type { P2pDataHandler, P2pStateHandler, P2pTransport } from "../p2pTransport";

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface FakeDeliveryRecord {
  from: string;
  to: string;
  kind: P2pEnvelope["kind"];
  messageId: string | null;
  t: number;
}

export interface FakeP2pMetrics {
  /** Sends of a given messageId from the origin peer (group_chat / chat). */
  originFanout(originPeerId: string, messageId: string): number;
  maxDegreeObserved(): number;
  duplicateDeliveries(messageId: string): number;
  totalSends(): number;
  deliveriesFor(messageId: string): FakeDeliveryRecord[];
}

function extractMessageId(envelope: P2pEnvelope): string | null {
  const p = envelope.payload;
  if (p && typeof p === "object" && "messageId" in p) {
    const id = (p as { messageId?: unknown }).messageId;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export class FakeP2pHub {
  private readonly endpoints = new Map<string, FakeP2pEndpoint>();
  /** Undirected open edges */
  private readonly edges = new Set<string>();
  /** peerId → partition label; peers in different partitions cannot connect/send */
  private readonly partitionOf = new Map<string, string>();
  private tick = 0;
  readonly deliveryLog: FakeDeliveryRecord[] = [];
  /** fromPeerId → count of successful sends */
  readonly sendCountByPeer = new Map<string, number>();
  /** `${from}->${to}:${messageId}` → count (for duplicate tracking at wire level) */
  private readonly wireDeliveries = new Map<string, number>();
  private maxDegreeSeen = 0;

  createEndpoint(peerId: string): FakeP2pEndpoint {
    if (this.endpoints.has(peerId)) {
      throw new Error(`Endpoint already exists: ${peerId}`);
    }
    if (!this.partitionOf.has(peerId)) this.partitionOf.set(peerId, "default");
    const ep = new FakeP2pEndpoint(this, peerId);
    this.endpoints.set(peerId, ep);
    return ep;
  }

  getEndpoint(peerId: string): FakeP2pEndpoint | undefined {
    return this.endpoints.get(peerId);
  }

  /** Instant bidirectional link (respects partitions). */
  connect(a: string, b: string): boolean {
    if (a === b) return false;
    if (this.partitionOf.get(a) !== this.partitionOf.get(b)) return false;
    const key = edgeKey(a, b);
    if (this.edges.has(key)) return true;
    this.edges.add(key);
    this.endpoints.get(a)?.notifyState(b, "connected");
    this.endpoints.get(b)?.notifyState(a, "connected");
    this.recordDegrees();
    return true;
  }

  disconnect(a: string, b: string): void {
    const key = edgeKey(a, b);
    if (!this.edges.has(key)) return;
    this.edges.delete(key);
    this.endpoints.get(a)?.notifyState(b, "disconnected");
    this.endpoints.get(b)?.notifyState(a, "disconnected");
  }

  isLinked(a: string, b: string): boolean {
    return this.edges.has(edgeKey(a, b));
  }

  neighbors(peerId: string): string[] {
    const out: string[] = [];
    for (const key of this.edges) {
      const [x, y] = key.split("|") as [string, string];
      if (x === peerId) out.push(y);
      else if (y === peerId) out.push(x);
    }
    return out;
  }

  /** Fully connect a set of peers (same partition). */
  fullyConnect(peerIds: string[]): void {
    for (let i = 0; i < peerIds.length; i++) {
      for (let j = i + 1; j < peerIds.length; j++) {
        this.connect(peerIds[i]!, peerIds[j]!);
      }
    }
  }

  /**
   * Split into components. Each group gets its own partition label.
   * Existing cross-partition edges are dropped.
   */
  partition(groups: string[][]): void {
    for (let i = 0; i < groups.length; i++) {
      const label = `part-${i}`;
      for (const peerId of groups[i]!) {
        this.partitionOf.set(peerId, label);
      }
    }
    for (const key of [...this.edges]) {
      const [a, b] = key.split("|") as [string, string];
      if (this.partitionOf.get(a) !== this.partitionOf.get(b)) {
        this.disconnect(a, b);
      }
    }
  }

  /** Put everyone back in the default partition (does not auto-reconnect). */
  healPartitions(): void {
    for (const peerId of this.endpoints.keys()) {
      this.partitionOf.set(peerId, "default");
    }
  }

  route(from: string, to: string, envelope: P2pEnvelope): boolean {
    if (!this.isLinked(from, to)) return false;
    if (this.partitionOf.get(from) !== this.partitionOf.get(to)) return false;
    const dest = this.endpoints.get(to);
    if (!dest) return false;

    this.tick += 1;
    const messageId = extractMessageId(envelope);
    const rec: FakeDeliveryRecord = {
      from,
      to,
      kind: envelope.kind,
      messageId,
      t: this.tick,
    };
    this.deliveryLog.push(rec);
    this.sendCountByPeer.set(from, (this.sendCountByPeer.get(from) ?? 0) + 1);

    if (messageId) {
      const wireKey = `${from}->${to}:${messageId}`;
      this.wireDeliveries.set(wireKey, (this.wireDeliveries.get(wireKey) ?? 0) + 1);
    }

    // Deliver synchronously (deterministic)
    dest.receive(from, envelope);
    this.recordDegrees();
    return true;
  }

  metrics(): FakeP2pMetrics {
    return {
      originFanout: (originPeerId, messageId) => {
        return this.deliveryLog.filter(
          (d) =>
            d.from === originPeerId &&
            d.messageId === messageId &&
            (d.kind === "group_chat" || d.kind === "chat"),
        ).length;
      },
      maxDegreeObserved: () => this.maxDegreeSeen,
      duplicateDeliveries: (messageId) => {
        // Count extras beyond first delivery to the same peer (any from)
        const byTo = new Map<string, number>();
        for (const d of this.deliveryLog) {
          if (d.messageId !== messageId) continue;
          if (d.kind !== "group_chat" && d.kind !== "chat") continue;
          byTo.set(d.to, (byTo.get(d.to) ?? 0) + 1);
        }
        let extras = 0;
        for (const n of byTo.values()) {
          if (n > 1) extras += n - 1;
        }
        return extras;
      },
      totalSends: () => this.deliveryLog.length,
      deliveriesFor: (messageId) => this.deliveryLog.filter((d) => d.messageId === messageId),
    };
  }

  private recordDegrees(): void {
    for (const peerId of this.endpoints.keys()) {
      const deg = this.neighbors(peerId).length;
      if (deg > this.maxDegreeSeen) this.maxDegreeSeen = deg;
    }
  }
}

export class FakeP2pEndpoint implements P2pTransport {
  private readonly hub: FakeP2pHub;
  readonly peerId: string;
  private readonly dataHandlers = new Set<P2pDataHandler>();
  private readonly stateHandlers = new Set<P2pStateHandler>();
  private readonly states = new Map<string, P2pState>();

  constructor(hub: FakeP2pHub, peerId: string) {
    this.hub = hub;
    this.peerId = peerId;
  }

  send(remotePeerId: string, envelope: P2pEnvelope): boolean {
    return this.hub.route(this.peerId, remotePeerId, envelope);
  }

  isConnected(remotePeerId: string): boolean {
    return this.hub.isLinked(this.peerId, remotePeerId);
  }

  listConnectedPeers(): string[] {
    return this.hub.neighbors(this.peerId);
  }

  listConnectingPeers(): string[] {
    const out: string[] = [];
    for (const [peerId, state] of this.states) {
      if (state === "connecting") out.push(peerId);
    }
    return out;
  }

  async connectToPeer(remotePeerId: string): Promise<void> {
    if (this.peerId === remotePeerId) return;
    if (this.isConnected(remotePeerId)) return;
    this.notifyState(remotePeerId, "connecting");
    const ok = this.hub.connect(this.peerId, remotePeerId);
    if (!ok) {
      this.notifyState(remotePeerId, "failed");
    }
  }

  async ensureConnections(peerIds: string[], maxDegree: number): Promise<string[]> {
    const connected = new Set(this.listConnectedPeers());
    const connecting = new Set(this.listConnectingPeers());
    const slots = Math.max(0, maxDegree - connected.size - connecting.size);
    if (slots === 0) return [];
    const targets = peerIds
      .filter((p) => p !== this.peerId && !connected.has(p) && !connecting.has(p))
      .slice(0, slots);
    for (const t of targets) {
      await this.connectToPeer(t);
    }
    return targets;
  }

  onData(handler: P2pDataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onState(handler: P2pStateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Hub-internal: deliver inbound envelope */
  receive(fromPeerId: string, envelope: P2pEnvelope): void {
    for (const h of this.dataHandlers) h(fromPeerId, envelope);
  }

  notifyState(peerId: string, state: P2pState): void {
    this.states.set(peerId, state);
    for (const h of this.stateHandlers) h(peerId, state);
  }
}
