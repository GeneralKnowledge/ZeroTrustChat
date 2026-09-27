/**
 * @ztc/server-interface — the ONLY module permitted to talk to central infrastructure.
 *
 * All other client code (chat, crypto, contacts, messages, groups) must go through
 * this boundary. This package is designed to be independently open-sourced and audited.
 *
 * See README.md for the full allowlist of what may cross this boundary.
 */

import {
  type ClientToServerMessage,
  type ServerToClientMessage,
  FORBIDDEN_FIELD_NAMES,
  ALLOWED_CLIENT_FIELDS,
  parseClientMessage,
  parseServerMessage,
} from "@ztc/protocol";
import type { ConnectionState, ServerStats } from "@ztc/shared";

export type SignallingHandler = (msg: Extract<ServerToClientMessage, { type: "signalling" }>) => void;
export type PresenceHandler = (msg: Extract<ServerToClientMessage, { type: "presence_update" }>) => void;
export type PeerHandler = (
  msg:
    | Extract<ServerToClientMessage, { type: "peer_available" }>
    | Extract<ServerToClientMessage, { type: "peer_unavailable" }>,
) => void;
export type RelayHandler = (msg: Extract<ServerToClientMessage, { type: "relay_packet" }>) => void;
export type ErrorHandler = (msg: Extract<ServerToClientMessage, { type: "error" }>) => void;

export interface ServerInterfaceConfig {
  /** WebSocket URL, e.g. ws://localhost:8787 */
  url: string;
  /** Optional audit hook — every outbound message is passed here for tests. */
  onOutbound?: (message: ClientToServerMessage) => void;
  /** Optional audit hook — every inbound message. */
  onInbound?: (message: ServerToClientMessage) => void;
}

export interface PublishEphemeralKeyArgs {
  keyId: string;
  encryptedKeyMaterial: string;
  expiresAt: number;
  singleUse: boolean;
}

/**
 * Auditable network boundary.
 *
 * Intentionally narrow API. No method accepts plaintext messages, contact lists,
 * private keys, or conversation history.
 */
export class ServerInterface {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private peerId: string | null = null;
  private state: ConnectionState = "disconnected";
  private readonly config: ServerInterfaceConfig;
  private readonly signallingHandlers = new Set<SignallingHandler>();
  private readonly presenceHandlers = new Set<PresenceHandler>();
  private readonly peerHandlers = new Set<PeerHandler>();
  private readonly relayHandlers = new Set<RelayHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly outboundLog: ClientToServerMessage[] = [];
  private stats: ServerStats | null = null;
  private pending = new Map<string, { resolve: (v: ServerToClientMessage) => void; reject: (e: Error) => void }>();

  constructor(config: ServerInterfaceConfig) {
    this.config = config;
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Development/test: all outbound messages since connect. */
  getOutboundAuditLog(): readonly ClientToServerMessage[] {
    return this.outboundLog;
  }

  getLastServerStats(): ServerStats | null {
    return this.stats;
  }

  async connect(): Promise<void> {
    if (this.ws && (this.state === "connected" || this.state === "connecting")) {
      return;
    }
    this.state = "connecting";
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.url);
      this.ws = ws;
      ws.onopen = () => {
        this.state = "connected";
        resolve();
      };
      ws.onerror = () => {
        this.state = "failed";
        reject(new Error("WebSocket connection failed"));
      };
      ws.onclose = () => {
        this.state = "disconnected";
        this.ws = null;
      };
      ws.onmessage = (ev) => this.handleInbound(ev.data);
    });
  }

  async disconnect(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.closeSession();
      } catch {
        // best-effort
      }
    }
    this.ws?.close();
    this.ws = null;
    this.state = "disconnected";
    this.sessionId = null;
  }

  async registerEphemeralSession(peerId: string, ttlMs = 30 * 60 * 1000): Promise<{ sessionId: string; expiresAt: number }> {
    this.assertConnected();
    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.peerId = peerId;
    this.sessionId = sessionId;
    await this.send({
      type: "register_session",
      sessionId,
      peerId,
      expiresAt,
    });
    return { sessionId, expiresAt };
  }

  async closeSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.send({ type: "close_session", sessionId: this.sessionId });
    this.sessionId = null;
  }

  async requestPeer(targetPeerId: string): Promise<void> {
    this.assertSession();
    await this.send({
      type: "request_peer",
      sessionId: this.sessionId!,
      targetPeerId,
    });
  }

  async sendSignallingMessage(
    toPeerId: string,
    payload: Extract<ClientToServerMessage, { type: "signalling" }>["payload"],
  ): Promise<void> {
    this.assertSession();
    if (!this.peerId) throw new Error("peerId not set");
    await this.send({
      type: "signalling",
      sessionId: this.sessionId!,
      fromPeerId: this.peerId,
      toPeerId,
      payload,
    });
  }

  onSignallingMessage(handler: SignallingHandler): () => void {
    this.signallingHandlers.add(handler);
    return () => this.signallingHandlers.delete(handler);
  }

  async publishPresence(status: "online" | "offline"): Promise<void> {
    this.assertSession();
    if (!this.peerId) throw new Error("peerId not set");
    await this.send({
      type: "presence",
      sessionId: this.sessionId!,
      peerId: this.peerId,
      status,
    });
  }

  onPresence(handler: PresenceHandler): () => void {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  onPeer(handler: PeerHandler): () => void {
    this.peerHandlers.add(handler);
    return () => this.peerHandlers.delete(handler);
  }

  async publishEphemeralKey(args: PublishEphemeralKeyArgs): Promise<void> {
    this.assertSession();
    // Hard guard: reject anything that looks like plaintext or private keys
    assertSafeEphemeralMaterial(args.encryptedKeyMaterial);
    await this.send({
      type: "publish_ephemeral_key",
      sessionId: this.sessionId!,
      keyId: args.keyId,
      encryptedKeyMaterial: args.encryptedKeyMaterial,
      expiresAt: args.expiresAt,
      singleUse: args.singleUse,
    });
  }

  async retrieveEphemeralKey(keyId: string): Promise<string | null> {
    this.assertSession();
    await this.send({
      type: "retrieve_ephemeral_key",
      sessionId: this.sessionId!,
      keyId,
    });
    // Response arrives async via inbound; callers typically wait via Promise racing handlers.
    // For prototype simplicity we return via a short poll of pending map.
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      const key = `ephemeral:${keyId}`;
      this.pending.set(key, {
        resolve: (msg) => {
          clearTimeout(timeout);
          if (msg.type === "ephemeral_key_retrieved") {
            resolve(msg.encryptedKeyMaterial);
          } else {
            resolve(null);
          }
        },
        reject: () => {
          clearTimeout(timeout);
          resolve(null);
        },
      });
    });
  }

  async sendRelayPacket(toPeerId: string, opaquePayload: string): Promise<void> {
    this.assertSession();
    if (!this.peerId) throw new Error("peerId not set");
    assertSafeEphemeralMaterial(opaquePayload);
    await this.send({
      type: "relay_packet",
      sessionId: this.sessionId!,
      fromPeerId: this.peerId,
      toPeerId,
      opaquePayload,
    });
  }

  onRelay(handler: RelayHandler): () => void {
    this.relayHandlers.add(handler);
    return () => this.relayHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  async fetchServerStats(): Promise<ServerStats> {
    this.assertSession();
    await this.send({ type: "get_stats", sessionId: this.sessionId! });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("stats timeout")), 3000);
      this.pending.set("stats", {
        resolve: (msg) => {
          clearTimeout(timeout);
          if (msg.type === "server_stats") {
            const stats: ServerStats = {
              activeSessions: msg.activeSessions,
              ephemeralKeys: msg.ephemeralKeys,
              messagesStored: msg.messagesStored,
              messagePlaintextReceived: msg.messagePlaintextReceived,
              contactListsReceived: msg.contactListsReceived,
              privateKeysReceived: msg.privateKeysReceived,
              signallingMessagesRelayed: msg.signallingMessagesRelayed,
            };
            this.stats = stats;
            resolve(stats);
          } else {
            reject(new Error("unexpected stats response"));
          }
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
    });
  }

  private async send(message: ClientToServerMessage): Promise<void> {
    this.assertConnected();
    auditOutbound(message);
    this.outboundLog.push(message);
    this.config.onOutbound?.(message);

    const validated = parseClientMessage(message);
    if (!validated.ok) {
      throw new Error(`Refusing to send invalid protocol message: ${validated.error}`);
    }

    this.ws!.send(JSON.stringify(validated.value));
  }

  private handleInbound(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      return;
    }
    const result = parseServerMessage(parsed);
    if (!result.ok) return;
    const msg = result.value;
    this.config.onInbound?.(msg);

    switch (msg.type) {
      case "signalling":
        for (const h of this.signallingHandlers) h(msg);
        break;
      case "presence_update":
        for (const h of this.presenceHandlers) h(msg);
        break;
      case "peer_available":
      case "peer_unavailable":
        for (const h of this.peerHandlers) h(msg);
        break;
      case "relay_packet":
        for (const h of this.relayHandlers) h(msg);
        break;
      case "error":
        for (const h of this.errorHandlers) h(msg);
        break;
      case "ephemeral_key_retrieved":
      case "ephemeral_key_missing": {
        const pending = this.pending.get(`ephemeral:${msg.keyId}`);
        pending?.resolve(msg);
        this.pending.delete(`ephemeral:${msg.keyId}`);
        break;
      }
      case "server_stats": {
        const pending = this.pending.get("stats");
        pending?.resolve(msg);
        this.pending.delete("stats");
        break;
      }
      default:
        break;
    }
  }

  private assertConnected(): void {
    if (!this.ws || this.state !== "connected") {
      throw new Error("Not connected to signalling server");
    }
  }

  private assertSession(): void {
    this.assertConnected();
    if (!this.sessionId) throw new Error("No active session");
  }
}

function assertSafeEphemeralMaterial(material: string): void {
  const lower = material.toLowerCase();
  for (const bad of ["privatekey", "begin private", "plaintext:"]) {
    if (lower.includes(bad)) {
      throw new Error("Refusing to send material that appears to contain secrets/plaintext");
    }
  }
}

/**
 * Deep audit: ensure outbound message only contains allowed fields and
 * never contains forbidden field names anywhere in the tree.
 */
export function auditOutbound(message: ClientToServerMessage): void {
  const type = message.type;
  const allowed = ALLOWED_CLIENT_FIELDS[type];
  if (!allowed) {
    throw new Error(`Unknown outbound type blocked by audit: ${type}`);
  }

  const keys = Object.keys(message);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new Error(`Unexpected field "${key}" in ${type}`);
    }
  }

  const json = JSON.stringify(message);
  for (const forbidden of FORBIDDEN_FIELD_NAMES) {
    // Check as JSON object keys: "forbidden":
    if (json.includes(`"${forbidden}"`)) {
      throw new Error(`Forbidden field name "${forbidden}" found in outbound ${type}`);
    }
  }
}

export { FORBIDDEN_FIELD_NAMES, ALLOWED_CLIENT_FIELDS, parseClientMessage };
