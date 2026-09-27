/**
 * Signed network manifest bootstrap + third-party server selection.
 *
 * ALL infrastructure HTTP/WebSocket for bootstrap and signalling stays here.
 * Chat/crypto/contacts modules must not call fetch/WebSocket directly.
 */

import { EMBEDDED_DEVELOPER_PUBLIC_KEY, verifyMessage } from "@ztc/crypto";
import {
  ALLOWED_CLIENT_FIELDS,
  FORBIDDEN_FIELD_NAMES,
  PROTOCOL_VERSION,
  canonicalJson,
  parseClientMessage,
  parseNetworkManifest,
  parseServerMessage,
  type ClientToServerMessage,
  type ManifestServerEntry,
  type NetworkManifest,
  type NetworkManifestBody,
  type ServerCapability,
  type ServerToClientMessage,
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

export type ServerSelectionKind = "official" | "community" | "custom";

export interface SelectedServer {
  kind: ServerSelectionKind;
  wsUrl: string;
  httpUrl?: string;
  serverId?: string;
  displayName: string;
  /** Expected Ed25519 public key when known from manifest; optional for custom. */
  expectedPublicKey?: string;
}

export interface VerifiedServerInfo {
  serverId: string;
  displayName: string;
  publicKey: string;
  protocolVersion: number;
  capabilities: ServerCapability[];
}

export interface ServerInterfaceConfig {
  /** Initial WebSocket URL (overridden after server selection). */
  url: string;
  /** Developer public key for manifest verification (defaults to embedded). */
  developerPublicKey?: string;
  onOutbound?: (message: ClientToServerMessage) => void;
  onInbound?: (message: ServerToClientMessage) => void;
}

export interface PublishEphemeralKeyArgs {
  keyId: string;
  encryptedKeyMaterial: string;
  expiresAt: number;
  singleUse: boolean;
}

const CLIENT_VERSION = "0.1.0";

/**
 * Auditable network boundary.
 *
 * Extends the original signalling API with:
 * - one-time signed manifest bootstrap (HTTP GET)
 * - third-party / custom server selection
 * - hello handshake verifying server identity + capabilities
 *
 * Still never accepts plaintext messages, contacts, or private keys.
 */
export class ServerInterface {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private peerId: string | null = null;
  private state: ConnectionState = "disconnected";
  private config: ServerInterfaceConfig;
  private readonly signallingHandlers = new Set<SignallingHandler>();
  private readonly presenceHandlers = new Set<PresenceHandler>();
  private readonly peerHandlers = new Set<PeerHandler>();
  private readonly relayHandlers = new Set<RelayHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly outboundLog: ClientToServerMessage[] = [];
  private stats: ServerStats | null = null;
  private pending = new Map<string, { resolve: (v: ServerToClientMessage) => void; reject: (e: Error) => void }>();
  private manifest: NetworkManifest | null = null;
  private selected: SelectedServer | null = null;
  private verifiedServer: VerifiedServerInfo | null = null;
  private readonly developerPublicKey: string;

  constructor(config: ServerInterfaceConfig) {
    this.config = config;
    this.developerPublicKey = config.developerPublicKey ?? EMBEDDED_DEVELOPER_PUBLIC_KEY;
    this.selected = {
      kind: "official",
      wsUrl: config.url,
      displayName: "Direct URL",
    };
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getOutboundAuditLog(): readonly ClientToServerMessage[] {
    return this.outboundLog;
  }

  getLastServerStats(): ServerStats | null {
    return this.stats;
  }

  getManifest(): NetworkManifest | null {
    return this.manifest;
  }

  getSelectedServer(): SelectedServer | null {
    return this.selected;
  }

  getVerifiedServer(): VerifiedServerInfo | null {
    return this.verifiedServer;
  }

  getDeveloperPublicKey(): string {
    return this.developerPublicKey;
  }

  /**
   * One-time (or refresh) bootstrap: fetch signed network manifest over HTTP.
   * This is the ONLY HTTP call in the client stack, and it lives here intentionally.
   */
  async fetchNetworkManifest(bootstrapHttpUrl: string): Promise<NetworkManifest> {
    const url = bootstrapHttpUrl.replace(/\/$/, "") + "/manifest";
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    }
    const raw: unknown = await res.json();
    return this.verifyAndStoreManifest(raw);
  }

  /** Verify a manifest object (from network or cache) against the embedded developer key. */
  verifyAndStoreManifest(raw: unknown): NetworkManifest {
    const parsed = parseNetworkManifest(raw);
    if (!parsed.ok) {
      throw new Error(`Invalid manifest: ${parsed.error}`);
    }
    const manifest = parsed.value;
    if (manifest.developerPublicKey !== this.developerPublicKey) {
      throw new Error("Manifest developerPublicKey does not match embedded key");
    }
    if (manifest.expiresAt < Date.now()) {
      throw new Error("Network manifest has expired");
    }
    if (manifest.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version ${manifest.protocolVersion}`);
    }
    const { signature, ...body } = manifest;
    const message = canonicalJson(body satisfies NetworkManifestBody);
    if (!verifyMessage(message, signature, this.developerPublicKey)) {
      throw new Error("Network manifest signature verification failed");
    }
    this.manifest = manifest;
    return manifest;
  }

  listManifestServers(): ManifestServerEntry[] {
    return this.manifest?.servers ?? [];
  }

  selectOfficialServer(): SelectedServer {
    const entry =
      this.listManifestServers().find((s) => s.official) ?? this.listManifestServers()[0];
    if (!entry) {
      // Fall back to constructor URL when no manifest yet
      this.selected = {
        kind: "official",
        wsUrl: this.config.url,
        displayName: "Official (default)",
      };
      return this.selected;
    }
    this.selected = toSelected(entry, "official");
    this.config = { ...this.config, url: this.selected.wsUrl };
    return this.selected;
  }

  selectCommunityServer(serverId: string): SelectedServer {
    const entry = this.listManifestServers().find((s) => s.serverId === serverId && s.community);
    if (!entry) throw new Error(`Community server not found: ${serverId}`);
    this.selected = toSelected(entry, "community");
    this.config = { ...this.config, url: this.selected.wsUrl };
    return this.selected;
  }

  selectManifestServer(serverId: string): SelectedServer {
    const entry = this.listManifestServers().find((s) => s.serverId === serverId);
    if (!entry) throw new Error(`Server not in manifest: ${serverId}`);
    const kind: ServerSelectionKind = entry.official ? "official" : entry.community ? "community" : "community";
    this.selected = toSelected(entry, kind);
    this.config = { ...this.config, url: this.selected.wsUrl };
    return this.selected;
  }

  /** User-entered self-hosted server. Identity verified at hello if expectedPublicKey given. */
  setCustomServer(wsUrl: string, opts?: { displayName?: string; expectedPublicKey?: string; httpUrl?: string }): SelectedServer {
    if (!/^wss?:\/\//.test(wsUrl)) {
      throw new Error("Custom server must be a ws:// or wss:// URL");
    }
    this.selected = {
      kind: "custom",
      wsUrl,
      httpUrl: opts?.httpUrl,
      displayName: opts?.displayName ?? "Custom server",
      expectedPublicKey: opts?.expectedPublicKey,
    };
    this.config = { ...this.config, url: wsUrl };
    return this.selected;
  }

  async connect(): Promise<void> {
    if (this.ws && (this.state === "connected" || this.state === "connecting")) {
      return;
    }
    const url = this.selected?.wsUrl ?? this.config.url;
    this.state = "connecting";
    this.verifiedServer = null;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
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

    // Handshake: verify server identity + protocol before any session work.
    await this.performHelloHandshake();
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
    this.verifiedServer = null;
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

  private async performHelloHandshake(): Promise<void> {
    await this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: CLIENT_VERSION,
    });

    const info = await new Promise<Extract<ServerToClientMessage, { type: "server_info" }>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server hello timeout")), 5000);
      this.pending.set("hello", {
        resolve: (msg) => {
          clearTimeout(timeout);
          if (msg.type === "server_info") resolve(msg);
          else reject(new Error("expected server_info"));
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
    });

    const { signature, type: _t, ...unsigned } = info;
    const message = canonicalJson(unsigned);
    if (!verifyMessage(message, signature, info.publicKey)) {
      throw new Error("Server identity signature invalid");
    }
    if (info.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Server protocol mismatch: ${info.protocolVersion}`);
    }
    if (!info.capabilities.includes("signalling")) {
      throw new Error("Server lacks required signalling capability");
    }

    const expected = this.selected?.expectedPublicKey;
    if (expected && expected !== info.publicKey) {
      throw new Error("Server public key does not match manifest entry");
    }
    if (this.selected?.serverId && this.selected.serverId !== info.serverId) {
      throw new Error("Server id does not match selected server");
    }

    this.verifiedServer = {
      serverId: info.serverId,
      displayName: info.displayName,
      publicKey: info.publicKey,
      protocolVersion: info.protocolVersion,
      capabilities: info.capabilities,
    };
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
      case "server_info": {
        const pending = this.pending.get("hello");
        pending?.resolve(msg);
        this.pending.delete("hello");
        break;
      }
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

function toSelected(entry: ManifestServerEntry, kind: ServerSelectionKind): SelectedServer {
  return {
    kind,
    wsUrl: entry.wsUrl,
    httpUrl: entry.httpUrl,
    serverId: entry.serverId,
    displayName: entry.displayName,
    expectedPublicKey: entry.publicKey,
  };
}

function assertSafeEphemeralMaterial(material: string): void {
  const lower = material.toLowerCase();
  for (const bad of ["privatekey", "begin private", "plaintext:"]) {
    if (lower.includes(bad)) {
      throw new Error("Refusing to send material that appears to contain secrets/plaintext");
    }
  }
}

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
    if (json.includes(`"${forbidden}"`)) {
      throw new Error(`Forbidden field name "${forbidden}" found in outbound ${type}`);
    }
  }
}

export { FORBIDDEN_FIELD_NAMES, ALLOWED_CLIENT_FIELDS, parseClientMessage, EMBEDDED_DEVELOPER_PUBLIC_KEY };
