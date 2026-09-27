/** Human-readable display names for local convenience (not cryptographic identity). */
const ADJECTIVES = [
  "red", "blue", "green", "amber", "silver", "quiet", "swift", "bold",
  "calm", "bright", "dark", "warm", "cool", "keen", "soft", "wild",
] as const;

const ANIMALS = [
  "otter", "wolf", "fox", "hawk", "bear", "lynx", "seal", "crane",
  "deer", "owl", "raven", "trout", "heron", "falcon", "badger", "mink",
] as const;

export function generateDisplayName(randomBytes: Uint8Array): string {
  if (randomBytes.length < 3) {
    throw new Error("Need at least 3 random bytes for display name");
  }
  const adj = ADJECTIVES[randomBytes[0]! % ADJECTIVES.length]!;
  const animal = ANIMALS[randomBytes[1]! % ANIMALS.length]!;
  const num = ((randomBytes[2]! << 8) | (randomBytes[3] ?? 0)) % 900 + 100;
  return `${adj}-${animal}-${num}`;
}

export type MessageStatus =
  | "pending"
  | "sending"
  | "delivered"
  | "expired"
  | "failed"
  | "decrypted"
  | "key_destroyed"
  | "deleted";

export type SecurityMode = "normal" | "expiring" | "time_limited" | "one_time";

export interface SecurityPolicy {
  mode: SecurityMode;
  /** ms from creation — stop attempting delivery after this */
  deliveryDeadlineMs?: number;
  /** ms from creation — delete local ciphertext/key after this */
  retentionDeadlineMs?: number;
  /** absolute timestamp — key becomes unavailable after this */
  decryptionDeadlineAt?: number;
  /** destroy key after first successful decrypt */
  oneTime?: boolean;
}

export const DEFAULT_POLICIES: Record<SecurityMode, Omit<SecurityPolicy, "mode" | "decryptionDeadlineAt">> = {
  normal: {},
  expiring: {
    deliveryDeadlineMs: 24 * 60 * 60 * 1000,
    retentionDeadlineMs: 7 * 24 * 60 * 60 * 1000,
  },
  time_limited: {
    deliveryDeadlineMs: 60 * 60 * 1000,
    retentionDeadlineMs: 24 * 60 * 60 * 1000,
  },
  one_time: {
    oneTime: true,
    retentionDeadlineMs: 24 * 60 * 60 * 1000,
  },
};

export function resolvePolicy(
  mode: SecurityMode,
  overrides?: Partial<SecurityPolicy>,
  now = Date.now(),
): SecurityPolicy {
  const base = DEFAULT_POLICIES[mode];
  const policy: SecurityPolicy = { mode, ...base, ...overrides };
  if (mode === "time_limited" && policy.decryptionDeadlineAt === undefined) {
    policy.decryptionDeadlineAt = now + 60 * 60 * 1000; // default 1 hour
  }
  return policy;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "failed";

export interface ClientStats {
  signallingState: ConnectionState;
  p2pState: ConnectionState;
  pendingMessages: number;
  expiredMessages: number;
  localContacts: number;
  p2pMessagesSent: number;
  p2pMessagesReceived: number;
}

export interface ServerStats {
  activeSessions: number;
  ephemeralKeys: number;
  messagesStored: number;
  messagePlaintextReceived: number;
  contactListsReceived: number;
  privateKeysReceived: number;
  signallingMessagesRelayed: number;
  introNameplatesActive?: number;
  introFramesRelayed?: number;
}

/** Client-side tally of outbound signalling contacts (WebSocket sends). */
export interface ServerContactStats {
  /** Total messages sent to the signalling server this connection. */
  total: number;
  /** Excludes get_stats (dev-only polling). */
  essential: number;
  byType: Record<string, number>;
}

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}
