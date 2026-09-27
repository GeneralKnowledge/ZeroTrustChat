/**
 * WebRTC P2P layer.
 *
 * ALL signalling goes through ServerInterface — no raw WebSocket/fetch here.
 */

import { ServerInterface } from "@ztc/server-interface";
import type { P2pTransport } from "./p2pTransport";

export type P2pState = "disconnected" | "connecting" | "connected" | "failed";

export type P2pEnvelopeKind =
  | "chat"
  | "group_chat"
  | "group_sync"
  | "group_epoch"
  | "group_digest"
  | "group_want"
  | "group_have"
  | "group_capability"
  | "ack"
  | "ping";

export interface P2pEnvelope {
  v: 1;
  kind: P2pEnvelopeKind;
  payload: unknown;
}

export interface PeerConnectionStats {
  state: P2pState;
  messagesSent: number;
  messagesReceived: number;
}

type DataHandler = (fromPeerId: string, envelope: P2pEnvelope) => void;
type StateHandler = (peerId: string, state: P2pState) => void;

type IceCandidateInit = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

const ICE_SERVERS: RTCIceServer[] = [];
// Local/prototype: host candidates only. Empty iceServers makes gathering complete
// immediately and avoids STUN timeouts that stall same-machine e2e.

export class P2pManager implements P2pTransport {
  private readonly si: ServerInterface;
  private readonly localPeerId: string;
  private readonly pcs = new Map<string, RTCPeerConnection>();
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly states = new Map<string, P2pState>();
  private readonly sent = new Map<string, number>();
  private readonly received = new Map<string, number>();
  private readonly pendingRemoteIce = new Map<string, IceCandidateInit[]>();
  private dataHandlers = new Set<DataHandler>();
  private stateHandlers = new Set<StateHandler>();
  private unsubSignalling: (() => void) | null = null;
  private unsubPeer: (() => void) | null = null;
  private makingOffer = new Set<string>();

  constructor(si: ServerInterface, localPeerId: string) {
    this.si = si;
    this.localPeerId = localPeerId;
  }

  start(): void {
    this.unsubSignalling = this.si.onSignallingMessage(async (msg) => {
      try {
        await this.handleSignalling(msg.fromPeerId, msg.payload);
      } catch (err) {
        console.error("signalling error", err);
      }
    });
    this.unsubPeer = this.si.onPeer((msg) => {
      if (msg.type !== "peer_available") return;
      // Peer came online while we were waiting — retry offer if we are the polite dialer.
      if (this.localPeerId > msg.peerId) return;
      if (this.channels.get(msg.peerId)?.readyState === "open") return;
      if (this.states.get(msg.peerId) === "connected") return;
      this.resetPeerIfNeeded(msg.peerId);
      this.setState(msg.peerId, "connecting");
      void this.createAndSendOffer(msg.peerId);
    });
  }

  stop(): void {
    this.unsubSignalling?.();
    this.unsubPeer?.();
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.channels.clear();
    this.pendingRemoteIce.clear();
  }

  onData(handler: DataHandler): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  getStats(peerId: string): PeerConnectionStats {
    return {
      state: this.states.get(peerId) ?? "disconnected",
      messagesSent: this.sent.get(peerId) ?? 0,
      messagesReceived: this.received.get(peerId) ?? 0,
    };
  }

  getAggregateStats(): { state: P2pState; messagesSent: number; messagesReceived: number } {
    let messagesSent = 0;
    let messagesReceived = 0;
    let anyConnected = false;
    let anyConnecting = false;
    for (const [peerId] of this.pcs) {
      const s = this.getStats(peerId);
      messagesSent += s.messagesSent;
      messagesReceived += s.messagesReceived;
      if (s.state === "connected") anyConnected = true;
      if (s.state === "connecting") anyConnecting = true;
    }
    return {
      state: anyConnected ? "connected" : anyConnecting ? "connecting" : "disconnected",
      messagesSent,
      messagesReceived,
    };
  }

  async connectToPeer(remotePeerId: string): Promise<void> {
    await this.si.requestPeer(remotePeerId);
    this.resetPeerIfNeeded(remotePeerId);
    this.getOrCreatePc(remotePeerId);
    if (this.channels.get(remotePeerId)?.readyState === "open") {
      return;
    }
    this.setState(remotePeerId, "connecting");

    // Avoid glare: only the lexicographically smaller peerId creates the offer.
    if (this.localPeerId > remotePeerId) {
      return;
    }

    await this.createAndSendOffer(remotePeerId);
  }

  /** Drop dead peer state so a later dial can create a fresh RTCPeerConnection. */
  private resetPeerIfNeeded(remotePeerId: string): void {
    const ch = this.channels.get(remotePeerId);
    const pc = this.pcs.get(remotePeerId);
    const channelDead = !ch || ch.readyState === "closed" || ch.readyState === "closing";
    const pcDead =
      !pc ||
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected";
    if (!channelDead && !pcDead) return;
    try {
      pc?.close();
    } catch {
      // ignore
    }
    this.pcs.delete(remotePeerId);
    this.channels.delete(remotePeerId);
    this.pendingRemoteIce.delete(remotePeerId);
    this.makingOffer.delete(remotePeerId);
  }

  private async createAndSendOffer(remotePeerId: string): Promise<void> {
    if (this.channels.get(remotePeerId)?.readyState === "open") return;
    if (this.makingOffer.has(remotePeerId)) return;

    const pc = this.getOrCreatePc(remotePeerId);
    if (!this.channels.has(remotePeerId)) {
      const channel = pc.createDataChannel("ztc", { ordered: true });
      this.bindChannel(remotePeerId, channel);
    }

    this.makingOffer.add(remotePeerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Bundle host candidates into SDP so connection works even if trickle is delayed.
      await this.waitForIceGathering(pc);
      await this.si.sendSignallingMessage(remotePeerId, {
        kind: "offer",
        sdp: pc.localDescription?.sdp ?? offer.sdp ?? "",
      });
    } finally {
      this.makingOffer.delete(remotePeerId);
    }
  }

  send(remotePeerId: string, envelope: P2pEnvelope): boolean {
    const ch = this.channels.get(remotePeerId);
    const pc = this.pcs.get(remotePeerId);
    if (!ch || ch.readyState !== "open") return false;
    if (
      pc &&
      pc.connectionState !== "connected" &&
      pc.iceConnectionState !== "connected" &&
      pc.iceConnectionState !== "completed"
    ) {
      return false;
    }
    try {
      ch.send(JSON.stringify(envelope));
    } catch {
      return false;
    }
    this.sent.set(remotePeerId, (this.sent.get(remotePeerId) ?? 0) + 1);
    return true;
  }

  isConnected(remotePeerId: string): boolean {
    return this.channels.get(remotePeerId)?.readyState === "open";
  }

  listConnectedPeers(): string[] {
    const out: string[] = [];
    for (const [peerId, ch] of this.channels) {
      if (ch.readyState === "open") out.push(peerId);
    }
    return out;
  }

  listConnectingPeers(): string[] {
    const out: string[] = [];
    for (const [peerId, state] of this.states) {
      if (state === "connecting") out.push(peerId);
    }
    return out;
  }

  /**
   * Dial peers up to a device-wide degree cap. Never disconnects existing edges.
   * Used by the shared group connection pool.
   */
  async ensureConnections(peerIds: string[], maxDegree: number): Promise<string[]> {
    const connected = new Set(this.listConnectedPeers());
    const connecting = new Set(this.listConnectingPeers());
    const slots = Math.max(0, maxDegree - connected.size - connecting.size);
    if (slots === 0) return [];
    const targets = peerIds.filter((p) => !connected.has(p) && !connecting.has(p)).slice(0, slots);
    await Promise.all(targets.map((t) => this.connectToPeer(t)));
    return targets;
  }

  private getOrCreatePc(remotePeerId: string): RTCPeerConnection {
    let pc = this.pcs.get(remotePeerId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pcs.set(remotePeerId, pc);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      void this.si.sendSignallingMessage(remotePeerId, {
        kind: "ice_candidate",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc!.connectionState;
      if (state === "failed") this.setState(remotePeerId, "failed");
      if (state === "disconnected" || state === "closed" || state === "failed") {
        const ch = this.channels.get(remotePeerId);
        try {
          ch?.close();
        } catch {
          // ignore
        }
        this.channels.delete(remotePeerId);
        if (state === "disconnected" || state === "closed") {
          this.setState(remotePeerId, "disconnected");
        }
      }
    };

    pc.ondatachannel = (ev) => {
      this.bindChannel(remotePeerId, ev.channel);
    };

    return pc;
  }

  private bindChannel(remotePeerId: string, channel: RTCDataChannel): void {
    this.channels.set(remotePeerId, channel);
    channel.onopen = () => this.setState(remotePeerId, "connected");
    channel.onclose = () => this.setState(remotePeerId, "disconnected");
    channel.onerror = () => this.setState(remotePeerId, "failed");
    channel.onmessage = (ev) => {
      try {
        const envelope = JSON.parse(String(ev.data)) as P2pEnvelope;
        this.received.set(remotePeerId, (this.received.get(remotePeerId) ?? 0) + 1);
        for (const h of this.dataHandlers) h(remotePeerId, envelope);
      } catch {
        // ignore malformed
      }
    };
  }

  private setState(peerId: string, state: P2pState): void {
    this.states.set(peerId, state);
    for (const h of this.stateHandlers) h(peerId, state);
  }

  /** Prefer bundled SDP; don't block forever if STUN is unreachable. */
  private async waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 1500): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    await Promise.race([
      new Promise<void>((resolve) => {
        const onChange = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", onChange);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", onChange);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async flushPendingIce(peerId: string, pc: RTCPeerConnection): Promise<void> {
    const pending = this.pendingRemoteIce.get(peerId);
    if (!pending?.length) return;
    this.pendingRemoteIce.delete(peerId);
    for (const c of pending) {
      try {
        await pc.addIceCandidate({
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? undefined,
          sdpMLineIndex: c.sdpMLineIndex ?? undefined,
        });
      } catch {
        // ignore stale
      }
    }
  }

  private async handleSignalling(
    fromPeerId: string,
    payload: {
      kind: string;
      sdp?: string;
      candidate?: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    },
  ): Promise<void> {
    const pc = this.getOrCreatePc(fromPeerId);

    if (payload.kind === "offer" && payload.sdp) {
      // Glare: if we already made an offer and we are the impolite peer, ignore remote offer.
      const offering = this.makingOffer.has(fromPeerId) || pc.signalingState === "have-local-offer";
      if (offering && this.localPeerId > fromPeerId) {
        return;
      }
      if (offering && this.localPeerId < fromPeerId) {
        // We are polite: roll back our offer and accept theirs.
        await pc.setLocalDescription({ type: "rollback" });
      }

      this.setState(fromPeerId, "connecting");
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      await this.flushPendingIce(fromPeerId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIceGathering(pc);
      await this.si.sendSignallingMessage(fromPeerId, {
        kind: "answer",
        sdp: pc.localDescription?.sdp ?? answer.sdp ?? "",
      });
    } else if (payload.kind === "answer" && payload.sdp) {
      if (pc.signalingState !== "have-local-offer") {
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      await this.flushPendingIce(fromPeerId, pc);
    } else if (payload.kind === "ice_candidate" && payload.candidate) {
      const init: IceCandidateInit = {
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
      };
      if (!pc.remoteDescription) {
        const q = this.pendingRemoteIce.get(fromPeerId) ?? [];
        q.push(init);
        this.pendingRemoteIce.set(fromPeerId, q);
        return;
      }
      try {
        await pc.addIceCandidate({
          candidate: init.candidate,
          sdpMid: init.sdpMid ?? undefined,
          sdpMLineIndex: init.sdpMLineIndex ?? undefined,
        });
      } catch {
        // ignore late candidates
      }
    }
  }
}
