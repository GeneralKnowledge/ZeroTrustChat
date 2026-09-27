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

export const GetStatsSchema = strictObject({
  type: z.literal("get_stats"),
  sessionId: SessionIdSchema,
});

export const ClientToServerSchema = z.discriminatedUnion("type", [
  RegisterSessionSchema,
  CloseSessionSchema,
  RequestPeerSchema,
  SignallingSchema,
  PresenceSchema,
  PublishEphemeralKeySchema,
  RetrieveEphemeralKeySchema,
  RelayPacketSchema,
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
});

export const ServerToClientSchema = z.discriminatedUnion("type", [
  SessionRegisteredSchema,
  PeerAvailableSchema,
  PeerUnavailableSchema,
  SignallingDeliveredSchema,
  PresenceUpdateSchema,
  EphemeralKeyStoredSchema,
  EphemeralKeyRetrievedSchema,
  EphemeralKeyMissingSchema,
  RelayDeliveredSchema,
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
  get_stats: ["type", "sessionId"],
};

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
