/**
 * WebRTC P2P layer.
 *
 * ALL signalling goes through ServerInterface — no raw WebSocket/fetch here.
 */

import { ServerInterface } from "@ztc/server-interface";

export type P2pState = "disconnected" | "connecting" | "connected" | "failed";

export type P2pEnvelopeKind =
  | "chat"
  | "group_chat"
  | "group_sync"
  | "group_epoch"
  | "group_digest"
  | "group_want"
  | "group_have"
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

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// Prefer including host candidates for local prototype / same-machine e2e.

export class P2pManager {
  private readonly si: ServerInterface;
  private readonly localPeerId: string;
  private readonly pcs = new Map<string, RTCPeerConnection>();
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly states = new Map<string, P2pState>();
  private readonly sent = new Map<string, number>();
  private readonly received = new Map<string, number>();
  private dataHandlers = new Set<DataHandler>();
  private stateHandlers = new Set<StateHandler>();
  private unsubSignalling: (() => void) | null = null;
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
  }

  stop(): void {
    this.unsubSignalling?.();
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.channels.clear();
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
      await this.si.sendSignallingMessage(remotePeerId, {
        kind: "offer",
        sdp: offer.sdp ?? "",
      });
    } finally {
      this.makingOffer.delete(remotePeerId);
    }
  }

  send(remotePeerId: string, envelope: P2pEnvelope): boolean {
    const ch = this.channels.get(remotePeerId);
    if (!ch || ch.readyState !== "open") return false;
    ch.send(JSON.stringify(envelope));
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
      if (pc!.connectionState === "failed") this.setState(remotePeerId, "failed");
      if (pc!.connectionState === "disconnected" || pc!.connectionState === "closed") {
        this.setState(remotePeerId, "disconnected");
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

  private async handleSignalling(
    fromPeerId: string,
    payload: { kind: string; sdp?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null },
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
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.si.sendSignallingMessage(fromPeerId, {
        kind: "answer",
        sdp: answer.sdp ?? "",
      });
    } else if (payload.kind === "answer" && payload.sdp) {
      if (pc.signalingState !== "have-local-offer") {
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    } else if (payload.kind === "ice_candidate" && payload.candidate) {
      try {
        await pc.addIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.sdpMid ?? undefined,
          sdpMLineIndex: payload.sdpMLineIndex ?? undefined,
        });
      } catch {
        // ignore late candidates
      }
    }
  }
}
