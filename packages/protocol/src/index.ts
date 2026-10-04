import { z } from "zod";

/**
 * Strict server protocol schemas.
 *
 * Forbidden (intentionally absent):
 * - send_message / store_message
 * - store_contact / store_profile
 * - upload_history / upload_private_key
 * - any plaintext chat fields
 */

const FORBIDDEN_TYPES = [
  "send_message",
  "store_message",
  "store_contact",
  "store_profile",
  "upload_history",
  "upload_private_key",
  "mailbox_deposit",
  "mailbox_fetch",
] as const;

export { FORBIDDEN_TYPES };

/** Reject objects with unexpected keys. */
function strictObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

export const SessionIdSchema = z.string().uuid();
export const PeerIdSchema = z.string().min(8).max(128);
export const KeyIdSchema = z.string().uuid();

export const RegisterSessionSchema = strictObject({
  type: z.literal("register_session"),
  sessionId: SessionIdSchema,
  peerId: PeerIdSchema,
  expiresAt: z.number().int().positive(),
});

export const CloseSessionSchema = strictObject({
  type: z.literal("close_session"),
  sessionId: SessionIdSchema,
});

export const RequestPeerSchema = strictObject({
  type: z.literal("request_peer"),
  sessionId: SessionIdSchema,
  targetPeerId: PeerIdSchema,
});

export const SignallingPayloadSchema = z.discriminatedUnion("kind", [
  strictObject({
    kind: z.literal("offer"),
    sdp: z.string().min(1).max(64_000),
  }),
  strictObject({
    kind: z.literal("answer"),
    sdp: z.string().min(1).max(64_000),
  }),
  strictObject({
    kind: z.literal("ice_candidate"),
    candidate: z.string().max(8_000),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nullable(),
  }),
]);

export const SignallingSchema = strictObject({
  type: z.literal("signalling"),
  sessionId: SessionIdSchema,
  fromPeerId: PeerIdSchema,
  toPeerId: PeerIdSchema,
  payload: SignallingPayloadSchema,
});

export const PresenceSchema = strictObject({
  type: z.literal("presence"),
  sessionId: SessionIdSchema,
  peerId: PeerIdSchema,
  status: z.enum(["online", "offline"]),
});

export const PublishEphemeralKeySchema = strictObject({
  type: z.literal("publish_ephemeral_key"),
  sessionId: SessionIdSchema,
  keyId: KeyIdSchema,
  /** Opaque ciphertext blob — never plaintext message or private identity key. */
  encryptedKeyMaterial: z.string().min(1).max(16_384),
  expiresAt: z.number().int().positive(),
  singleUse: z.boolean(),
});

export const RetrieveEphemeralKeySchema = strictObject({
  type: z.literal("retrieve_ephemeral_key"),
  sessionId: SessionIdSchema,
  keyId: KeyIdSchema,
});

/**
 * Opaque relay packet for rare fallbacks (e.g. NAT traversal assist metadata).
 * MUST NOT contain plaintext chat. Contents are opaque ciphertext only.
 */
export const RelayPacketSchema = strictObject({
  type: z.literal("relay_packet"),
  sessionId: SessionIdSchema,
  fromPeerId: PeerIdSchema,
  toPeerId: PeerIdSchema,
  opaquePayload: z.string().min(1).max(65_536),
});

/** Short-lived PAKE intro nameplate (Wormhole-style). Digits only, 1–6 chars. */
export const IntroNameplateSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,5}$/, "nameplate must be 1–6 digit number without leading zero");

/** Claim a one-shot intro nameplate (TTL enforced server-side). */
export const IntroClaimSchema = strictObject({
  type: z.literal("intro_claim"),
  sessionId: SessionIdSchema,
  nameplate: IntroNameplateSchema,
  expiresAt: z.number().int().positive(),
});

/** Join an existing intro nameplate (second peer). */
export const IntroJoinSchema = strictObject({
  type: z.literal("intro_join"),
  sessionId: SessionIdSchema,
  nameplate: IntroNameplateSchema,
});

/**
 * Opaque intro frame relay between the two sessions on a nameplate.
 * Server must not parse opaquePayload — PAKE shares / encrypted identity only.
 */
export const IntroRelaySchema = strictObject({
  type: z.literal("intro_relay"),
  sessionId: SessionIdSchema,
  nameplate: IntroNameplateSchema,
  opaquePayload: z.string().min(1).max(65_536),
});

/** Release / tear down a nameplate after success or abort. */
export const IntroReleaseSchema = strictObject({
  type: z.literal("intro_release"),
  sessionId: SessionIdSchema,
  nameplate: IntroNameplateSchema,
});

export const GetStatsSchema = strictObject({
  type: z.literal("get_stats"),
  sessionId: SessionIdSchema,
});

/** Client hello — verify protocol compatibility before registering a session. */
export const HelloSchema = strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  clientVersion: z.string().min(1).max(32),
});

export const ClientToServerSchema = z.discriminatedUnion("type", [
  HelloSchema,
  RegisterSessionSchema,
  CloseSessionSchema,
  RequestPeerSchema,
  SignallingSchema,
  PresenceSchema,
  PublishEphemeralKeySchema,
  RetrieveEphemeralKeySchema,
  RelayPacketSchema,
  IntroClaimSchema,
  IntroJoinSchema,
  IntroRelaySchema,
  IntroReleaseSchema,
  GetStatsSchema,
]);

export type ClientToServerMessage = z.infer<typeof ClientToServerSchema>;

export const SessionRegisteredSchema = strictObject({
  type: z.literal("session_registered"),
  sessionId: SessionIdSchema,
  expiresAt: z.number().int().positive(),
});

export const PeerAvailableSchema = strictObject({
  type: z.literal("peer_available"),
  peerId: PeerIdSchema,
  sessionId: SessionIdSchema,
});

export const PeerUnavailableSchema = strictObject({
  type: z.literal("peer_unavailable"),
  peerId: PeerIdSchema,
});

export const SignallingDeliveredSchema = strictObject({
  type: z.literal("signalling"),
  fromPeerId: PeerIdSchema,
  toPeerId: PeerIdSchema,
  payload: SignallingPayloadSchema,
});

export const PresenceUpdateSchema = strictObject({
  type: z.literal("presence_update"),
  peerId: PeerIdSchema,
  status: z.enum(["online", "offline"]),
});

export const EphemeralKeyStoredSchema = strictObject({
  type: z.literal("ephemeral_key_stored"),
  keyId: KeyIdSchema,
  expiresAt: z.number().int().positive(),
});

export const EphemeralKeyRetrievedSchema = strictObject({
  type: z.literal("ephemeral_key_retrieved"),
  keyId: KeyIdSchema,
  encryptedKeyMaterial: z.string(),
});

export const EphemeralKeyMissingSchema = strictObject({
  type: z.literal("ephemeral_key_missing"),
  keyId: KeyIdSchema,
});

export const RelayDeliveredSchema = strictObject({
  type: z.literal("relay_packet"),
  fromPeerId: PeerIdSchema,
  toPeerId: PeerIdSchema,
  opaquePayload: z.string(),
});

export const IntroClaimedSchema = strictObject({
  type: z.literal("intro_claimed"),
  nameplate: IntroNameplateSchema,
  expiresAt: z.number().int().positive(),
});

export const IntroJoinedSchema = strictObject({
  type: z.literal("intro_joined"),
  nameplate: IntroNameplateSchema,
});

/** Notifies the claimer that a second peer joined the nameplate. */
export const IntroPeerJoinedSchema = strictObject({
  type: z.literal("intro_peer_joined"),
  nameplate: IntroNameplateSchema,
});

export const IntroFrameSchema = strictObject({
  type: z.literal("intro_frame"),
  nameplate: IntroNameplateSchema,
  opaquePayload: z.string(),
});

export const IntroReleasedSchema = strictObject({
  type: z.literal("intro_released"),
  nameplate: IntroNameplateSchema,
});

export const ErrorSchema = strictObject({
  type: z.literal("error"),
  code: z.enum([
    "unknown_type",
    "invalid_schema",
    "unexpected_fields",
    "forbidden_operation",
    "session_expired",
    "session_not_found",
    "peer_not_found",
    "rate_limited",
    "protocol_mismatch",
    "intro_crowded",
    "intro_expired",
    "intro_not_found",
    "internal",
  ]),
  message: z.string().max(500),
});

export const ServerStatsSchema = strictObject({
  type: z.literal("server_stats"),
  activeSessions: z.number().int().nonnegative(),
  ephemeralKeys: z.number().int().nonnegative(),
  messagesStored: z.literal(0),
  messagePlaintextReceived: z.literal(0),
  contactListsReceived: z.literal(0),
  privateKeysReceived: z.literal(0),
  signallingMessagesRelayed: z.number().int().nonnegative(),
  introNameplatesActive: z.number().int().nonnegative().optional(),
  introFramesRelayed: z.number().int().nonnegative().optional(),
});

export const ServerCapabilitySchema = z.enum([
  "signalling",
  "rendezvous",
  "ephemeral_keys",
  "relay",
  "stun",
  "turn",
]);

export type ServerCapability = z.infer<typeof ServerCapabilitySchema>;

export const ServerInfoSchema = strictObject({
  type: z.literal("server_info"),
  serverId: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128),
  publicKey: z.string().min(64).max(128),
  protocolVersion: z.number().int().positive(),
  capabilities: z.array(ServerCapabilitySchema).min(1),
  /** Ed25519 signature over canonical server info payload (hex). */
  signature: z.string().min(64).max(256),
});

export const ServerToClientSchema = z.discriminatedUnion("type", [
  ServerInfoSchema,
  SessionRegisteredSchema,
  PeerAvailableSchema,
  PeerUnavailableSchema,
  SignallingDeliveredSchema,
  PresenceUpdateSchema,
  EphemeralKeyStoredSchema,
  EphemeralKeyRetrievedSchema,
  EphemeralKeyMissingSchema,
  RelayDeliveredSchema,
  IntroClaimedSchema,
  IntroJoinedSchema,
  IntroPeerJoinedSchema,
  IntroFrameSchema,
  IntroReleasedSchema,
  ErrorSchema,
  ServerStatsSchema,
]);

export type ServerToClientMessage = z.infer<typeof ServerToClientSchema>;

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: "unknown_type" | "invalid_schema" | "forbidden_operation" | "unexpected_fields" };

export function parseClientMessage(raw: unknown): ParseResult<ClientToServerMessage> {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    return { ok: false, error: "Message must be an object with a type field", code: "invalid_schema" };
  }

  const type = (raw as { type: unknown }).type;
  if (typeof type !== "string") {
    return { ok: false, error: "type must be a string", code: "invalid_schema" };
  }

  if ((FORBIDDEN_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      error: `Forbidden operation: ${type}. Server does not store messages, contacts, or keys.`,
      code: "forbidden_operation",
    };
  }

  const result = ClientToServerSchema.safeParse(raw);
  if (!result.success) {
    const hasUnknownType = result.error.issues.some(
      (i) => i.code === "invalid_union_discriminator" || (i.path[0] === "type" && i.code === "invalid_literal"),
    );
    const hasUnrecognized = result.error.issues.some((i) => i.code === "unrecognized_keys");
    if (hasUnrecognized) {
      return { ok: false, error: result.error.message, code: "unexpected_fields" };
    }
    if (hasUnknownType) {
      return { ok: false, error: `Unknown message type: ${type}`, code: "unknown_type" };
    }
    return { ok: false, error: result.error.message, code: "invalid_schema" };
  }

  return { ok: true, value: result.data };
}

export function parseServerMessage(raw: unknown): ParseResult<ServerToClientMessage> {
  const result = ServerToClientSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message, code: "invalid_schema" };
  }
  return { ok: true, value: result.data };
}

/** Allowed top-level field names per client message type — for audit tests. */
export const ALLOWED_CLIENT_FIELDS: Record<string, readonly string[]> = {
  hello: ["type", "protocolVersion", "clientVersion"],
  register_session: ["type", "sessionId", "peerId", "expiresAt"],
  close_session: ["type", "sessionId"],
  request_peer: ["type", "sessionId", "targetPeerId"],
  signalling: ["type", "sessionId", "fromPeerId", "toPeerId", "payload"],
  presence: ["type", "sessionId", "peerId", "status"],
  publish_ephemeral_key: [
    "type",
    "sessionId",
    "keyId",
    "encryptedKeyMaterial",
    "expiresAt",
    "singleUse",
  ],
  retrieve_ephemeral_key: ["type", "sessionId", "keyId"],
  relay_packet: ["type", "sessionId", "fromPeerId", "toPeerId", "opaquePayload"],
  intro_claim: ["type", "sessionId", "nameplate", "expiresAt"],
  intro_join: ["type", "sessionId", "nameplate"],
  intro_relay: ["type", "sessionId", "nameplate", "opaquePayload"],
  intro_release: ["type", "sessionId", "nameplate"],
  get_stats: ["type", "sessionId"],
};

/** Current wire protocol version for hello handshake. */
export const PROTOCOL_VERSION = 1;

/** Minimum client version string the official network expects. */
export const MIN_CLIENT_VERSION = "0.1.0";

export const ManifestServerEntrySchema = strictObject({
  serverId: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128),
  /** WebSocket signalling URL */
  wsUrl: z.string().url().max(512),
  /** Optional HTTPS bootstrap / health base (same host typically) */
  httpUrl: z.string().url().max(512).optional(),
  /** Ed25519 public key hex of this server's identity */
  publicKey: z.string().min(64).max(128),
  capabilities: z.array(ServerCapabilitySchema).min(1),
  official: z.boolean().optional(),
  community: z.boolean().optional(),
});

export type ManifestServerEntry = z.infer<typeof ManifestServerEntrySchema>;

/**
 * Unsigned body of the network manifest (signed by the developer key).
 * Does NOT contain messages, contacts, or private user data.
 */
export const NetworkManifestBodySchema = strictObject({
  protocolVersion: z.number().int().positive(),
  manifestVersion: z.number().int().positive(),
  developerPublicKey: z.string().min(64).max(128),
  minClientVersion: z.string().min(1).max(32),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  servers: z.array(ManifestServerEntrySchema).min(1).max(64),
});

export type NetworkManifestBody = z.infer<typeof NetworkManifestBodySchema>;

export const NetworkManifestSchema = NetworkManifestBodySchema.extend({
  /** Ed25519 signature over canonical body JSON (hex). */
  signature: z.string().min(64).max(256),
}).strict();

export type NetworkManifest = z.infer<typeof NetworkManifestSchema>;

export function parseNetworkManifest(raw: unknown): ParseResult<NetworkManifest> {
  const result = NetworkManifestSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message, code: "invalid_schema" };
  }
  return { ok: true, value: result.data };
}

/** Canonical JSON for signatures — sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

/** Fields that must NEVER appear in any client→server message. */
export const FORBIDDEN_FIELD_NAMES = [
  "plaintext",
  "message",
  "messageText",
  "body",
  "content",
  "privateKey",
  "secretKey",
  "identityPrivateKey",
  "contacts",
  "contactList",
  "history",
  "messages",
  "conversation",
  "attachment",
  "attachmentPlaintext",
  "password",
  "email",
  "phone",
] as const;
