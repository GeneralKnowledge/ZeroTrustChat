import type { Database } from "sql.js";
import type { MessageStatus, SecurityMode } from "@ztc/shared";

/**
 * Local SQLite via sql.js (WASM).
 * Persisted to localStorage for the browser prototype.
 *
 * Deviation note: browser cannot use better-sqlite3; sql.js provides SQLite semantics.
 * The UMD build is loaded from /public to avoid Vite ESM interop issues.
 */

type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | null) => Database;
};

let db: Database | null = null;
const STORAGE_KEY = "ztc-local-db-v1";

export interface LocalIdentity {
  peerId: string;
  publicKey: string;
  privateKey: string;
  displayName: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  /** Per-install id — not part of identity backup; namespaces senderSeq. */
  deviceId: string;
}

export interface Contact {
  peerId: string;
  publicKey: string;
  displayName: string;
  invitationCode: string;
  addedAt: number;
  signingPublicKey: string | null;
}

export interface StoredMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  ciphertext: string;
  nonce: string;
  messageKeyId: string;
  createdAt: number;
  deliveryDeadline: number | null;
  decryptionDeadline: number | null;
  retentionDeadline: number | null;
  status: MessageStatus;
  encryptionMetadata: string;
  wrappedKey: string | null;
  securityMode: SecurityMode;
  plaintextCache: string | null;
}

export interface MessageKeyRow {
  messageKeyId: string;
  keyHex: string;
  decryptionDeadlineAt: number | null;
  oneTime: number;
  destroyed: number;
}

export interface GroupRow {
  groupId: string;
  name: string;
  epoch: number;
  membersJson: string;
  epochKeyHex: string;
  createdAt: number;
}

async function initSql(): Promise<SqlJsStatic> {
  const w = window as unknown as { initSqlJs?: (cfg?: object) => Promise<SqlJsStatic> };
  if (!w.initSqlJs) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/sql-wasm.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load sql-wasm.js"));
      document.head.appendChild(script);
    });
  }
  if (!w.initSqlJs) throw new Error("initSqlJs not available");
  return w.initSqlJs({
    locateFile: (file: string) => `/${file}`,
  });
}

export async function openLocalStore(): Promise<Database> {
  if (db) return db;
  const SQL = await initSql();

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const bytes = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
    db = new SQL.Database(bytes);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      peer_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      display_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      peer_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      invitation_code TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      message_key_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivery_deadline INTEGER,
      decryption_deadline INTEGER,
      retention_deadline INTEGER,
      status TEXT NOT NULL,
      encryption_metadata TEXT NOT NULL,
      wrapped_key TEXT,
      security_mode TEXT NOT NULL,
      plaintext_cache TEXT
    );
    CREATE TABLE IF NOT EXISTS message_keys (
      message_key_id TEXT PRIMARY KEY,
      key_hex TEXT NOT NULL,
      decryption_deadline_at INTEGER,
      one_time INTEGER NOT NULL,
      destroyed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      members_json TEXT NOT NULL,
      epoch_key_hex TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_outbox (
      message_id TEXT PRIMARY KEY,
      recipient_peer_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivery_deadline INTEGER,
      retention_deadline INTEGER
    );
    CREATE TABLE IF NOT EXISTS network_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bootstrap_http_url TEXT NOT NULL,
      selected_kind TEXT NOT NULL,
      selected_ws_url TEXT NOT NULL,
      selected_http_url TEXT,
      selected_server_id TEXT,
      selected_display_name TEXT NOT NULL,
      selected_public_key TEXT,
      manifest_json TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      reactor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, reactor_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_pins (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      pinned_by TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );
  `);
  // Migrations for multi-device + signed epochs (sql.js supports ADD COLUMN).
  const migrations = [
    "ALTER TABLE identity ADD COLUMN signing_public_key TEXT",
    "ALTER TABLE identity ADD COLUMN signing_private_key TEXT",
    "ALTER TABLE identity ADD COLUMN device_id TEXT",
    "ALTER TABLE contacts ADD COLUMN signing_public_key TEXT",
    `CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      reactor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, reactor_id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversation_pins (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      pinned_by TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    )`,
  ];
  for (const sql of migrations) {
    try {
      db.run(sql);
    } catch {
      // column already exists
    }
  }
  persist();
  return db;
}

function requireDb(): Database {
  if (!db) throw new Error("Local store not open");
  return db;
}

export function persist(): void {
  if (!db) return;
  const data = db.export();
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  localStorage.setItem(STORAGE_KEY, btoa(binary));
}

export function getIdentity(): LocalIdentity | null {
  const d = requireDb();
  const row = d.exec(
    `SELECT peer_id, public_key, private_key, display_name,
            signing_public_key, signing_private_key, device_id
     FROM identity WHERE id = 1`,
  );
  if (!row[0]?.values[0]) return null;
  const v = row[0].values[0];
  return {
    peerId: String(v[0]),
    publicKey: String(v[1]),
    privateKey: String(v[2]),
    displayName: String(v[3]),
    signingPublicKey: v[4] == null ? "" : String(v[4]),
    signingPrivateKey: v[5] == null ? "" : String(v[5]),
    deviceId: v[6] == null || String(v[6]) === "" ? "" : String(v[6]),
  };
}

export function saveIdentity(id: LocalIdentity): void {
  const d = requireDb();
  d.run("DELETE FROM identity");
  d.run(
    `INSERT INTO identity (
      id, peer_id, public_key, private_key, display_name,
      signing_public_key, signing_private_key, device_id
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id.peerId,
      id.publicKey,
      id.privateKey,
      id.displayName,
      id.signingPublicKey,
      id.signingPrivateKey,
      id.deviceId,
    ],
  );
  persist();
}

export function listContacts(): Contact[] {
  const d = requireDb();
  const res = d.exec(
    `SELECT peer_id, public_key, display_name, invitation_code, added_at, signing_public_key
     FROM contacts ORDER BY added_at`,
  );
  if (!res[0]) return [];
  return res[0].values.map((v) => ({
    peerId: String(v[0]),
    publicKey: String(v[1]),
    displayName: String(v[2]),
    invitationCode: String(v[3]),
    addedAt: Number(v[4]),
    signingPublicKey: v[5] == null || String(v[5]) === "" ? null : String(v[5]),
  }));
}

export function upsertContact(c: Contact): void {
  const d = requireDb();
  d.run(
    `INSERT OR REPLACE INTO contacts
      (peer_id, public_key, display_name, invitation_code, added_at, signing_public_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [c.peerId, c.publicKey, c.displayName, c.invitationCode, c.addedAt, c.signingPublicKey],
  );
  persist();
}

export function saveMessage(m: StoredMessage): void {
  const d = requireDb();
  d.run(
    `INSERT OR REPLACE INTO messages (
      message_id, conversation_id, sender_id, ciphertext, nonce, message_key_id,
      created_at, delivery_deadline, decryption_deadline, retention_deadline,
      status, encryption_metadata, wrapped_key, security_mode, plaintext_cache
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.messageId,
      m.conversationId,
      m.senderId,
      m.ciphertext,
      m.nonce,
      m.messageKeyId,
      m.createdAt,
      m.deliveryDeadline,
      m.decryptionDeadline,
      m.retentionDeadline,
      m.status,
      m.encryptionMetadata,
      m.wrappedKey,
      m.securityMode,
      m.plaintextCache,
    ],
  );
  persist();
}

export function listMessages(conversationId: string): StoredMessage[] {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_id, conversation_id, sender_id, ciphertext, nonce, message_key_id,
            created_at, delivery_deadline, decryption_deadline, retention_deadline,
            status, encryption_metadata, wrapped_key, security_mode, plaintext_cache
     FROM messages WHERE conversation_id = ? ORDER BY created_at`,
    [conversationId],
  );
  if (!res[0]) return [];
  return res[0].values.map(rowToMessage);
}

export function listAllMessages(): StoredMessage[] {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_id, conversation_id, sender_id, ciphertext, nonce, message_key_id,
            created_at, delivery_deadline, decryption_deadline, retention_deadline,
            status, encryption_metadata, wrapped_key, security_mode, plaintext_cache
     FROM messages ORDER BY created_at`,
  );
  if (!res[0]) return [];
  return res[0].values.map(rowToMessage);
}

function rowToMessage(v: unknown[]): StoredMessage {
  return {
    messageId: String(v[0]),
    conversationId: String(v[1]),
    senderId: String(v[2]),
    ciphertext: String(v[3]),
    nonce: String(v[4]),
    messageKeyId: String(v[5]),
    createdAt: Number(v[6]),
    deliveryDeadline: v[7] == null ? null : Number(v[7]),
    decryptionDeadline: v[8] == null ? null : Number(v[8]),
    retentionDeadline: v[9] == null ? null : Number(v[9]),
    status: String(v[10]) as MessageStatus,
    encryptionMetadata: String(v[11]),
    wrappedKey: v[12] == null ? null : String(v[12]),
    securityMode: String(v[13]) as SecurityMode,
    plaintextCache: v[14] == null ? null : String(v[14]),
  };
}

export function updateMessageStatus(messageId: string, status: MessageStatus, plaintextCache?: string | null): void {
  const d = requireDb();
  if (plaintextCache !== undefined) {
    d.run("UPDATE messages SET status = ?, plaintext_cache = ? WHERE message_id = ?", [
      status,
      plaintextCache,
      messageId,
    ]);
  } else {
    d.run("UPDATE messages SET status = ? WHERE message_id = ?", [status, messageId]);
  }
  persist();
}

/** Set or clear a reaction (idempotent — safe under gossip duplicates). */
export function applyReaction(
  messageId: string,
  reactorId: string,
  emoji: string,
  op: "set" | "clear" = "set",
): void {
  const d = requireDb();
  if (op === "clear") {
    d.run(`DELETE FROM message_reactions WHERE message_id = ? AND reactor_id = ?`, [
      messageId,
      reactorId,
    ]);
  } else {
    d.run(
      `INSERT OR REPLACE INTO message_reactions (message_id, reactor_id, emoji) VALUES (?, ?, ?)`,
      [messageId, reactorId, emoji],
    );
  }
  persist();
}

export function listReactions(messageId: string): Array<{ reactorId: string; emoji: string }> {
  const d = requireDb();
  const res = d.exec(
    `SELECT reactor_id, emoji FROM message_reactions WHERE message_id = ?`,
    [messageId],
  );
  if (!res[0]) return [];
  return res[0].values.map((v) => ({
    reactorId: String(v[0]),
    emoji: String(v[1]),
  }));
}

/** Aggregate emoji → count for UI pills. */
export function reactionSummary(messageId: string): Array<{ emoji: string; count: number }> {
  const all = listReactions(messageId);
  const map = new Map<string, number>();
  for (const r of all) {
    map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1);
  }
  return [...map.entries()].map(([emoji, count]) => ({ emoji, count }));
}

export function markMessageDeleted(messageId: string): void {
  const d = requireDb();
  d.run(`UPDATE messages SET status = ?, plaintext_cache = ? WHERE message_id = ?`, [
    "deleted",
    null,
    messageId,
  ]);
  persist();
}

/**
 * Apply an edit to the local display cache (sender-only).
 * Original ciphertext is left as-is; peers learn the new body via the edit control message.
 */
export function applyMessageEdit(messageId: string, editorId: string, body: string): boolean {
  const m = getMessage(messageId);
  if (!m || m.senderId !== editorId || m.status === "deleted") return false;
  let replyTo: string | undefined;
  if (m.plaintextCache) {
    try {
      const p = JSON.parse(m.plaintextCache) as { type?: string; replyTo?: string };
      if (p.type === "text" && typeof p.replyTo === "string") replyTo = p.replyTo;
    } catch {
      // legacy plaintext — no reply pointer
    }
  }
  const plaintext = JSON.stringify(
    replyTo
      ? { v: 1, type: "text", body, replyTo }
      : { v: 1, type: "text", body },
  );
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(m.encryptionMetadata) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  meta.edited = true;
  meta.editedAt = Date.now();
  const d = requireDb();
  d.run(`UPDATE messages SET plaintext_cache = ?, encryption_metadata = ? WHERE message_id = ?`, [
    plaintext,
    JSON.stringify(meta),
    messageId,
  ]);
  persist();
  return true;
}

export function isMessageEdited(messageId: string): boolean {
  const m = getMessage(messageId);
  if (!m) return false;
  try {
    const meta = JSON.parse(m.encryptionMetadata) as { edited?: boolean };
    return meta.edited === true;
  } catch {
    return false;
  }
}

export function applyPin(
  conversationId: string,
  messageId: string,
  pinnedBy: string,
  op: "set" | "clear",
): void {
  const d = requireDb();
  if (op === "clear") {
    d.run(`DELETE FROM conversation_pins WHERE conversation_id = ? AND message_id = ?`, [
      conversationId,
      messageId,
    ]);
  } else {
    d.run(
      `INSERT OR REPLACE INTO conversation_pins (conversation_id, message_id, pinned_by, pinned_at)
       VALUES (?, ?, ?, ?)`,
      [conversationId, messageId, pinnedBy, Date.now()],
    );
  }
  persist();
}

export function listPins(conversationId: string): Array<{
  messageId: string;
  pinnedBy: string;
  pinnedAt: number;
}> {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_id, pinned_by, pinned_at FROM conversation_pins
     WHERE conversation_id = ? ORDER BY pinned_at DESC`,
    [conversationId],
  );
  if (!res[0]) return [];
  return res[0].values.map((v) => ({
    messageId: String(v[0]),
    pinnedBy: String(v[1]),
    pinnedAt: Number(v[2]),
  }));
}

export function isPinned(conversationId: string, messageId: string): boolean {
  const d = requireDb();
  const res = d.exec(
    `SELECT 1 FROM conversation_pins WHERE conversation_id = ? AND message_id = ?`,
    [conversationId, messageId],
  );
  return Boolean(res[0]?.values[0]);
}

export function getMessage(messageId: string): StoredMessage | null {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_id, conversation_id, sender_id, ciphertext, nonce, message_key_id,
            created_at, delivery_deadline, decryption_deadline, retention_deadline,
            status, encryption_metadata, wrapped_key, security_mode, plaintext_cache
     FROM messages WHERE message_id = ?`,
    [messageId],
  );
  if (!res[0]?.values[0]) return null;
  return rowToMessage(res[0].values[0]);
}

export function saveMessageKey(k: MessageKeyRow): void {
  const d = requireDb();
  d.run(
    `INSERT OR REPLACE INTO message_keys (message_key_id, key_hex, decryption_deadline_at, one_time, destroyed)
     VALUES (?, ?, ?, ?, ?)`,
    [k.messageKeyId, k.keyHex, k.decryptionDeadlineAt, k.oneTime, k.destroyed],
  );
  persist();
}

export function getMessageKey(messageKeyId: string): MessageKeyRow | null {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_key_id, key_hex, decryption_deadline_at, one_time, destroyed FROM message_keys WHERE message_key_id = ?`,
    [messageKeyId],
  );
  if (!res[0]?.values[0]) return null;
  const v = res[0].values[0];
  return {
    messageKeyId: String(v[0]),
    keyHex: String(v[1]),
    decryptionDeadlineAt: v[2] == null ? null : Number(v[2]),
    oneTime: Number(v[3]),
    destroyed: Number(v[4]),
  };
}

export function destroyStoredMessageKey(messageKeyId: string): void {
  const d = requireDb();
  d.run(`UPDATE message_keys SET key_hex = '', destroyed = 1 WHERE message_key_id = ?`, [messageKeyId]);
  d.run(`UPDATE messages SET plaintext_cache = NULL, status = 'key_destroyed' WHERE message_key_id = ? AND status != 'expired'`, [
    messageKeyId,
  ]);
  persist();
}

export function deleteExpiredMessages(now = Date.now()): number {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_id, message_key_id FROM messages
     WHERE retention_deadline IS NOT NULL AND retention_deadline <= ?`,
    [now],
  );
  let count = 0;
  if (res[0]) {
    for (const v of res[0].values) {
      const mid = String(v[0]);
      const kid = String(v[1]);
      d.run(`DELETE FROM messages WHERE message_id = ?`, [mid]);
      d.run(`UPDATE message_keys SET key_hex = '', destroyed = 1 WHERE message_key_id = ?`, [kid]);
      count++;
    }
  }
  d.run(
    `UPDATE messages SET status = 'expired' WHERE status IN ('pending','sending')
     AND delivery_deadline IS NOT NULL AND delivery_deadline <= ?`,
    [now],
  );
  const keys = d.exec(
    `SELECT message_key_id FROM message_keys
     WHERE destroyed = 0 AND decryption_deadline_at IS NOT NULL AND decryption_deadline_at <= ?`,
    [now],
  );
  if (keys[0]) {
    for (const v of keys[0].values) {
      destroyStoredMessageKey(String(v[0]));
    }
  }
  d.run(`DELETE FROM pending_outbox WHERE retention_deadline IS NOT NULL AND retention_deadline <= ?`, [now]);
  d.run(`DELETE FROM pending_outbox WHERE delivery_deadline IS NOT NULL AND delivery_deadline <= ?`, [now]);
  persist();
  return count;
}

export function countByStatus(status: MessageStatus): number {
  const d = requireDb();
  const res = d.exec(`SELECT COUNT(*) FROM messages WHERE status = ?`, [status]);
  return Number(res[0]?.values[0]?.[0] ?? 0);
}

export function enqueueOutbox(
  messageId: string,
  recipientPeerId: string,
  payloadJson: string,
  createdAt: number,
  deliveryDeadline: number | null,
  retentionDeadline: number | null,
): void {
  const d = requireDb();
  d.run(
    `INSERT OR REPLACE INTO pending_outbox
     (message_id, recipient_peer_id, payload_json, created_at, delivery_deadline, retention_deadline)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [messageId, recipientPeerId, payloadJson, createdAt, deliveryDeadline, retentionDeadline],
  );
  persist();
}

export function listOutbox(now = Date.now()): Array<{
  messageId: string;
  recipientPeerId: string;
  payloadJson: string;
}> {
  const d = requireDb();
  const res = d.exec(
    `SELECT message_id, recipient_peer_id, payload_json FROM pending_outbox
     WHERE (delivery_deadline IS NULL OR delivery_deadline > ?)
       AND (retention_deadline IS NULL OR retention_deadline > ?)`,
    [now, now],
  );
  if (!res[0]) return [];
  return res[0].values.map((v) => ({
    messageId: String(v[0]),
    recipientPeerId: String(v[1]),
    payloadJson: String(v[2]),
  }));
}

export function removeOutbox(messageId: string): void {
  const d = requireDb();
  d.run(`DELETE FROM pending_outbox WHERE message_id = ?`, [messageId]);
  persist();
}

export function saveGroup(g: GroupRow): void {
  const d = requireDb();
  d.run(
    `INSERT OR REPLACE INTO groups (group_id, name, epoch, members_json, epoch_key_hex, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [g.groupId, g.name, g.epoch, g.membersJson, g.epochKeyHex, g.createdAt],
  );
  persist();
}

export function listGroups(): GroupRow[] {
  const d = requireDb();
  const res = d.exec(`SELECT group_id, name, epoch, members_json, epoch_key_hex, created_at FROM groups`);
  if (!res[0]) return [];
  return res[0].values.map((v) => ({
    groupId: String(v[0]),
    name: String(v[1]),
    epoch: Number(v[2]),
    membersJson: String(v[3]),
    epochKeyHex: String(v[4]),
    createdAt: Number(v[5]),
  }));
}

export function getGroup(groupId: string): GroupRow | null {
  const d = requireDb();
  const res = d.exec(
    `SELECT group_id, name, epoch, members_json, epoch_key_hex, created_at FROM groups WHERE group_id = ?`,
    [groupId],
  );
  if (!res[0]?.values[0]) return null;
  const v = res[0].values[0];
  return {
    groupId: String(v[0]),
    name: String(v[1]),
    epoch: Number(v[2]),
    membersJson: String(v[3]),
    epochKeyHex: String(v[4]),
    createdAt: Number(v[5]),
  };
}

export function encodeInvitation(identity: LocalIdentity): string {
  const payload = {
    v: 2,
    peerId: identity.peerId,
    publicKey: identity.publicKey,
    signingPublicKey: identity.signingPublicKey,
    displayName: identity.displayName,
  };
  return `ztc1:${btoa(JSON.stringify(payload))}`;
}

export function decodeInvitation(code: string): Omit<Contact, "addedAt" | "invitationCode"> {
  if (!code.startsWith("ztc1:")) throw new Error("Invalid invitation code");
  const parsed = JSON.parse(atob(code.slice(5))) as {
    peerId: string;
    publicKey: string;
    displayName: string;
    signingPublicKey?: string;
  };
  if (!parsed.peerId || !parsed.publicKey) throw new Error("Malformed invitation");
  return {
    peerId: parsed.peerId,
    publicKey: parsed.publicKey,
    displayName: parsed.displayName,
    signingPublicKey: parsed.signingPublicKey ?? null,
  };
}

export interface StoredNetworkConfig {
  bootstrapHttpUrl: string;
  selectedKind: "official" | "community" | "custom";
  selectedWsUrl: string;
  selectedHttpUrl: string | null;
  selectedServerId: string | null;
  selectedDisplayName: string;
  selectedPublicKey: string | null;
  manifestJson: string | null;
  updatedAt: number;
}

export function getNetworkConfig(): StoredNetworkConfig | null {
  const d = requireDb();
  const res = d.exec(
    `SELECT bootstrap_http_url, selected_kind, selected_ws_url, selected_http_url,
            selected_server_id, selected_display_name, selected_public_key, manifest_json, updated_at
     FROM network_config WHERE id = 1`,
  );
  if (!res[0]?.values[0]) return null;
  const v = res[0].values[0];
  return {
    bootstrapHttpUrl: String(v[0]),
    selectedKind: String(v[1]) as StoredNetworkConfig["selectedKind"],
    selectedWsUrl: String(v[2]),
    selectedHttpUrl: v[3] == null ? null : String(v[3]),
    selectedServerId: v[4] == null ? null : String(v[4]),
    selectedDisplayName: String(v[5]),
    selectedPublicKey: v[6] == null ? null : String(v[6]),
    manifestJson: v[7] == null ? null : String(v[7]),
    updatedAt: Number(v[8]),
  };
}

export function saveNetworkConfig(cfg: StoredNetworkConfig): void {
  const d = requireDb();
  d.run("DELETE FROM network_config");
  d.run(
    `INSERT INTO network_config (
      id, bootstrap_http_url, selected_kind, selected_ws_url, selected_http_url,
      selected_server_id, selected_display_name, selected_public_key, manifest_json, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cfg.bootstrapHttpUrl,
      cfg.selectedKind,
      cfg.selectedWsUrl,
      cfg.selectedHttpUrl,
      cfg.selectedServerId,
      cfg.selectedDisplayName,
      cfg.selectedPublicKey,
      cfg.manifestJson,
      cfg.updatedAt,
    ],
  );
  persist();
}
