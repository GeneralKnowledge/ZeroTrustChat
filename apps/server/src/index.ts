/**
 * Development signalling server.
 *
 * Stores ONLY:
 * - ephemeral sessions
 * - ephemeral encrypted key material
 * - presence (who's online)
 *
 * NEVER stores:
 * - messages / message plaintext
 * - contacts
 * - private keys
 * - conversation history
 *
 * Dev uses SQLite for convenience. Production design = RAM-only (see docs).
 */

import { WebSocketServer, WebSocket } from "ws";
import Database from "better-sqlite3";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from "@ztc/protocol";
import {
  PROTOTYPE_OFFICIAL_SERVER_PRIVATE,
  PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
  ServerIdentity,
} from "./identity.js";
import { buildOfficialManifest } from "./manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info") as "error" | "warn" | "info" | "debug";
const DB_PATH = process.env.ZTC_DB_PATH ?? join(__dirname, "..", "data", "dev.sqlite");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

function log(level: keyof typeof LEVELS, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] > LEVELS[LOG_LEVEL]) return;
  // Privacy-preserving: never log payloads that could contain secrets
  const safe = meta ? JSON.stringify(meta) : "";
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg} ${safe}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

interface SessionRow {
  session_id: string;
  peer_id: string;
  expires_at: number;
}

interface EphemeralKeyRow {
  key_id: string;
  encrypted_key_material: string;
  created_at: number;
  expires_at: number;
  single_use: number;
}

export class SignallingServer {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private db!: Database.Database;
  private dbPath: string = DB_PATH;
  private listenPort = PORT;
  private identity!: ServerIdentity;
  private sockets = new Map<string, WebSocket>(); // sessionId -> ws
  private peerToSession = new Map<string, string>(); // peerId -> sessionId
  private sessionToPeer = new Map<string, string>();
  /**
   * Short-lived PAKE intro nameplates (RAM only — never message storage).
   * At most two sessions per nameplate; torn down on release/expiry.
   */
  private intros = new Map<
    string,
    { claimerSessionId: string; joinerSessionId: string | null; expiresAt: number }
  >();
  /** Privacy audit counters — always zero for message content. */
  readonly counters = {
    messagesStored: 0 as const,
    messagePlaintextReceived: 0 as const,
    contactListsReceived: 0 as const,
    privateKeysReceived: 0 as const,
    signallingMessagesRelayed: 0,
    introNameplatesActive: 0,
    introFramesRelayed: 0,
  };
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  start(port = PORT, dbPath = process.env.ZTC_DB_PATH ?? DB_PATH): void {
    this.listenPort = port;
    this.dbPath = dbPath;
    this.identity = new ServerIdentity({
      displayName: process.env.ZTC_SERVER_NAME ?? "Official (local prototype)",
      privateKeyHex: PROTOTYPE_OFFICIAL_SERVER_PRIVATE,
      publicKeyHex: PROTOTYPE_OFFICIAL_SERVER_PUBLIC,
    });

    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ephemeral_keys (
        key_id TEXT PRIMARY KEY,
        encrypted_key_material TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        single_use INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_peer ON sessions(peer_id);
      CREATE INDEX IF NOT EXISTS idx_keys_expires ON ephemeral_keys(expires_at);
    `);

    // DEV-ONLY: clear leftover sessions on boot so restart test is clean
    this.db.prepare("DELETE FROM sessions").run();
    log("info", "dev sessions cleared on boot (production would be RAM-only)");

    this.httpServer = createServer((req, res) => {
      const path = req.url?.split("?")[0] ?? "";
      if (path === "/health") {
        const stats = this.getStats();
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(
          JSON.stringify({
            ok: true,
            ...stats,
            serverId: this.identity.serverId,
            displayName: this.identity.displayName,
            capabilities: this.identity.capabilities,
            protocolVersion: PROTOCOL_VERSION,
          }),
        );
        return;
      }
      if (path === "/manifest") {
        const manifest = buildOfficialManifest({
          port: this.listenPort,
          includeCommunityAlias: true,
        });
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(manifest));
        return;
      }
      if (path === "/server-info") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(this.identity.buildServerInfo()));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.cleanupTimer = setInterval(() => this.expireState(), 5_000);

    this.httpServer.listen(port, () => {
      log("info", `signalling server listening`, {
        port,
        logLevel: LOG_LEVEL,
        db: this.dbPath,
        serverIdPrefix: this.identity.serverId.slice(0, 12),
      });
    });
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const ws of this.sockets.values()) {
      ws.removeAllListeners();
      ws.close();
    }
    this.sockets.clear();
    this.peerToSession.clear();
    this.sessionToPeer.clear();
    this.intros.clear();
    this.wss?.close();
    this.httpServer?.close();
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    log("info", "server stopped");
  }

  /** For tests: count rows that look like messages (should always be 0 tables). */
  getMessageTableCount(): number {
    const tables = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%message%'`,
      )
      .all() as { name: string }[];
    return tables.length;
  }

  getStats() {
    this.expireState();
    const sessions = (
      this.db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE expires_at > ?`).get(Date.now()) as {
        c: number;
      }
    ).c;
    const keys = (
      this.db.prepare(`SELECT COUNT(*) as c FROM ephemeral_keys WHERE expires_at > ?`).get(Date.now()) as {
        c: number;
      }
    ).c;
    return {
      type: "server_stats" as const,
      activeSessions: sessions,
      ephemeralKeys: keys,
      messagesStored: 0 as const,
      messagePlaintextReceived: 0 as const,
      contactListsReceived: 0 as const,
      privateKeysReceived: 0 as const,
      signallingMessagesRelayed: this.counters.signallingMessagesRelayed,
      introNameplatesActive: this.intros.size,
      introFramesRelayed: this.counters.introFramesRelayed,
    };
  }

  private onConnection(ws: WebSocket): void {
    log("debug", "ws connected");
    let boundSession: string | null = null;

    ws.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        this.send(ws, { type: "error", code: "invalid_schema", message: "Invalid JSON" });
        return;
      }

      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        log("warn", "rejected client message", { code: parsed.error });
        this.send(ws, {
          type: "error",
          code: parsed.code,
          message: parsed.error.slice(0, 500),
        });
        return;
      }

      try {
        boundSession = this.handleMessage(ws, parsed.value, boundSession);
      } catch (err) {
        log("error", "handler error", {
          err: err instanceof Error ? err.message : "unknown",
        });
        this.send(ws, { type: "error", code: "internal", message: "Internal error" });
      }
    });

    ws.on("close", () => {
      if (boundSession) {
        try {
          this.removeSession(boundSession);
        } catch {
          // shutdown race
        }
      }
      log("debug", "ws closed", { session: boundSession ? "yes" : "no" });
    });
  }

  private handleMessage(
    ws: WebSocket,
    msg: ClientToServerMessage,
    boundSession: string | null,
  ): string | null {
    switch (msg.type) {
      case "hello": {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.send(ws, {
            type: "error",
            code: "protocol_mismatch",
            message: `Server requires protocol ${PROTOCOL_VERSION}`,
          });
          return boundSession;
        }
        this.send(ws, this.identity.buildServerInfo());
        return boundSession;
      }
      case "register_session": {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO sessions (session_id, peer_id, expires_at) VALUES (?, ?, ?)`,
          )
          .run(msg.sessionId, msg.peerId, msg.expiresAt);
        this.sockets.set(msg.sessionId, ws);
        this.peerToSession.set(msg.peerId, msg.sessionId);
        this.sessionToPeer.set(msg.sessionId, msg.peerId);
        this.send(ws, {
          type: "session_registered",
          sessionId: msg.sessionId,
          expiresAt: msg.expiresAt,
        });
        // Broadcast presence
        this.broadcastPresence(msg.peerId, "online", msg.sessionId);
        log("info", "session registered", { peerPrefix: msg.peerId.slice(0, 8) });
        return msg.sessionId;
      }
      case "close_session": {
        this.removeSession(msg.sessionId);
        return null;
      }
      case "request_peer": {
        this.requireSession(msg.sessionId);
        const targetSession = this.peerToSession.get(msg.targetPeerId);
        if (targetSession && this.sockets.has(targetSession)) {
          this.send(ws, {
            type: "peer_available",
            peerId: msg.targetPeerId,
            sessionId: targetSession,
          });
        } else {
          this.send(ws, { type: "peer_unavailable", peerId: msg.targetPeerId });
        }
        return boundSession;
      }
      case "signalling": {
        this.requireSession(msg.sessionId);
        const targetSession = this.peerToSession.get(msg.toPeerId);
        const targetWs = targetSession ? this.sockets.get(targetSession) : undefined;
        if (!targetWs) {
          this.send(ws, { type: "error", code: "peer_not_found", message: "Peer offline" });
          return boundSession;
        }
        // Relay signalling only — never inspect/store SDP beyond relay
        this.send(targetWs, {
          type: "signalling",
          fromPeerId: msg.fromPeerId,
          toPeerId: msg.toPeerId,
          payload: msg.payload,
        });
        this.counters.signallingMessagesRelayed += 1;
        log("debug", "signalling relayed", { kind: msg.payload.kind });
        return boundSession;
      }
      case "presence": {
        this.requireSession(msg.sessionId);
        this.broadcastPresence(msg.peerId, msg.status, msg.sessionId);
        return boundSession;
      }
      case "publish_ephemeral_key": {
        this.requireSession(msg.sessionId);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO ephemeral_keys
             (key_id, encrypted_key_material, created_at, expires_at, single_use)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            msg.keyId,
            msg.encryptedKeyMaterial,
            Date.now(),
            msg.expiresAt,
            msg.singleUse ? 1 : 0,
          );
        this.send(ws, {
          type: "ephemeral_key_stored",
          keyId: msg.keyId,
          expiresAt: msg.expiresAt,
        });
        log("info", "ephemeral key stored", { keyPrefix: msg.keyId.slice(0, 8) });
        return boundSession;
      }
      case "retrieve_ephemeral_key": {
        this.requireSession(msg.sessionId);
        const row = this.db
          .prepare(`SELECT * FROM ephemeral_keys WHERE key_id = ?`)
          .get(msg.keyId) as EphemeralKeyRow | undefined;
        if (!row || row.expires_at < Date.now()) {
          if (row) {
            this.db.prepare(`DELETE FROM ephemeral_keys WHERE key_id = ?`).run(msg.keyId);
          }
          this.send(ws, { type: "ephemeral_key_missing", keyId: msg.keyId });
          return boundSession;
        }
        this.send(ws, {
          type: "ephemeral_key_retrieved",
          keyId: msg.keyId,
          encryptedKeyMaterial: row.encrypted_key_material,
        });
        if (row.single_use) {
          this.db.prepare(`DELETE FROM ephemeral_keys WHERE key_id = ?`).run(msg.keyId);
        }
        return boundSession;
      }
      case "relay_packet": {
        this.requireSession(msg.sessionId);
        const targetSession = this.peerToSession.get(msg.toPeerId);
        const targetWs = targetSession ? this.sockets.get(targetSession) : undefined;
        if (!targetWs) {
          this.send(ws, { type: "error", code: "peer_not_found", message: "Peer offline" });
          return boundSession;
        }
        this.send(targetWs, {
          type: "relay_packet",
          fromPeerId: msg.fromPeerId,
          toPeerId: msg.toPeerId,
          opaquePayload: msg.opaquePayload,
        });
        return boundSession;
      }
      case "intro_claim": {
        this.requireSession(msg.sessionId);
        this.expireIntros();
        const existing = this.intros.get(msg.nameplate);
        if (existing && existing.expiresAt > Date.now()) {
          this.send(ws, {
            type: "error",
            code: "intro_crowded",
            message: "Nameplate already in use",
          });
          return boundSession;
        }
        const ttlCap = Date.now() + 10 * 60 * 1000;
        const expiresAt = Math.min(msg.expiresAt, ttlCap);
        this.intros.set(msg.nameplate, {
          claimerSessionId: msg.sessionId,
          joinerSessionId: null,
          expiresAt,
        });
        this.send(ws, { type: "intro_claimed", nameplate: msg.nameplate, expiresAt });
        log("info", "intro claimed", { nameplate: msg.nameplate });
        return boundSession;
      }
      case "intro_join": {
        this.requireSession(msg.sessionId);
        this.expireIntros();
        const slot = this.intros.get(msg.nameplate);
        if (!slot || slot.expiresAt <= Date.now()) {
          this.intros.delete(msg.nameplate);
          this.send(ws, {
            type: "error",
            code: "intro_not_found",
            message: "Intro nameplate missing or expired",
          });
          return boundSession;
        }
        if (slot.joinerSessionId) {
          this.send(ws, {
            type: "error",
            code: "intro_crowded",
            message: "Intro already has two peers",
          });
          return boundSession;
        }
        if (slot.claimerSessionId === msg.sessionId) {
          this.send(ws, {
            type: "error",
            code: "intro_crowded",
            message: "Cannot join own intro",
          });
          return boundSession;
        }
        slot.joinerSessionId = msg.sessionId;
        this.send(ws, { type: "intro_joined", nameplate: msg.nameplate });
        const claimerWs = this.sockets.get(slot.claimerSessionId);
        if (claimerWs) {
          this.send(claimerWs, { type: "intro_peer_joined", nameplate: msg.nameplate });
        }
        log("info", "intro joined", { nameplate: msg.nameplate });
        return boundSession;
      }
      case "intro_relay": {
        this.requireSession(msg.sessionId);
        this.expireIntros();
        const slot = this.intros.get(msg.nameplate);
        if (!slot || slot.expiresAt <= Date.now()) {
          this.intros.delete(msg.nameplate);
          this.send(ws, {
            type: "error",
            code: "intro_expired",
            message: "Intro expired",
          });
          return boundSession;
        }
        const peerSession =
          msg.sessionId === slot.claimerSessionId
            ? slot.joinerSessionId
            : msg.sessionId === slot.joinerSessionId
              ? slot.claimerSessionId
              : null;
        if (!peerSession) {
          this.send(ws, {
            type: "error",
            code: "intro_not_found",
            message: "Not a participant of this intro",
          });
          return boundSession;
        }
        const peerWs = this.sockets.get(peerSession);
        if (!peerWs) {
          this.send(ws, { type: "error", code: "peer_not_found", message: "Intro peer offline" });
          return boundSession;
        }
        // Opaque only — never inspect PAKE / identity ciphertext
        this.send(peerWs, {
          type: "intro_frame",
          nameplate: msg.nameplate,
          opaquePayload: msg.opaquePayload,
        });
        this.counters.introFramesRelayed += 1;
        return boundSession;
      }
      case "intro_release": {
        this.requireSession(msg.sessionId);
        const slot = this.intros.get(msg.nameplate);
        if (
          slot &&
          (slot.claimerSessionId === msg.sessionId || slot.joinerSessionId === msg.sessionId)
        ) {
          this.intros.delete(msg.nameplate);
          this.send(ws, { type: "intro_released", nameplate: msg.nameplate });
          const other =
            slot.claimerSessionId === msg.sessionId
              ? slot.joinerSessionId
              : slot.claimerSessionId;
          if (other) {
            const otherWs = this.sockets.get(other);
            if (otherWs) {
              this.send(otherWs, { type: "intro_released", nameplate: msg.nameplate });
            }
          }
          log("info", "intro released", { nameplate: msg.nameplate });
        } else {
          this.send(ws, { type: "intro_released", nameplate: msg.nameplate });
        }
        return boundSession;
      }
      case "get_stats": {
        this.requireSession(msg.sessionId);
        this.send(ws, this.getStats());
        return boundSession;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        this.send(ws, { type: "error", code: "unknown_type", message: "Unknown type" });
        return boundSession;
      }
    }
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw Object.assign(new Error("session not found"), { code: "session_not_found" });
    if (row.expires_at < Date.now()) {
      this.removeSession(sessionId);
      throw Object.assign(new Error("session expired"), { code: "session_expired" });
    }
    return row;
  }

  private removeSession(sessionId: string): void {
    const peerId = this.sessionToPeer.get(sessionId);
    try {
      if (this.db && this.db.open) {
        this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
      }
    } catch {
      // DB may already be closed during shutdown
    }
    this.sockets.delete(sessionId);
    this.sessionToPeer.delete(sessionId);
    if (peerId) {
      this.peerToSession.delete(peerId);
      try {
        this.broadcastPresence(peerId, "offline", sessionId);
      } catch {
        // ignore during shutdown
      }
    }
  }

  private broadcastPresence(
    peerId: string,
    status: "online" | "offline",
    exceptSession?: string,
  ): void {
    const msg: ServerToClientMessage = { type: "presence_update", peerId, status };
    for (const [sid, ws] of this.sockets) {
      if (sid === exceptSession) continue;
      this.send(ws, msg);
    }
  }

  private expireState(): void {
    const now = Date.now();
    const expiredSessions = this.db
      .prepare(`SELECT session_id FROM sessions WHERE expires_at <= ?`)
      .all(now) as { session_id: string }[];
    for (const s of expiredSessions) {
      this.removeSession(s.session_id);
    }
    const deleted = this.db.prepare(`DELETE FROM ephemeral_keys WHERE expires_at <= ?`).run(now);
    if (deleted.changes > 0) {
      log("debug", "expired ephemeral keys", { count: deleted.changes });
    }
    this.expireIntros();
  }

  private expireIntros(): void {
    const now = Date.now();
    for (const [np, slot] of this.intros) {
      if (slot.expiresAt <= now) this.intros.delete(np);
    }
  }

  private send(ws: WebSocket, msg: ServerToClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

// Always allow CLI start: `tsx src/index.ts` or ZTC_SERVER_AUTOSTART=1
const invokedDirectly =
  process.argv[1]?.includes("apps/server") ||
  process.argv[1]?.endsWith("src/index.ts") ||
  process.env.ZTC_SERVER_AUTOSTART === "1";

if (invokedDirectly) {
  const server = new SignallingServer();
  server.start();
  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { SignallingServer as default };
