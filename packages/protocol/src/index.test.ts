import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_TYPES,
  parseClientMessage,
} from "./index.js";

const validSession = "550e8400-e29b-41d4-a716-446655440000";
const peerId = "peer-alice-identity-pubkey-hex";

describe("parseClientMessage", () => {
  it("accepts register_session", () => {
    const result = parseClientMessage({
      type: "register_session",
      sessionId: validSession,
      peerId,
      expiresAt: Date.now() + 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown types", () => {
    const result = parseClientMessage({ type: "totally_unknown", sessionId: validSession });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_type");
  });

  it("rejects forbidden mailbox operations", () => {
    for (const type of FORBIDDEN_TYPES) {
      const result = parseClientMessage({ type, sessionId: validSession });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("forbidden_operation");
    }
  });

  it("rejects unexpected fields", () => {
    const result = parseClientMessage({
      type: "register_session",
      sessionId: validSession,
      peerId,
      expiresAt: Date.now() + 60_000,
      plaintext: "secret chat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unexpected_fields");
  });

  it("rejects signalling with extra payload fields", () => {
    const result = parseClientMessage({
      type: "signalling",
      sessionId: validSession,
      fromPeerId: peerId,
      toPeerId: "peer-bob",
      payload: { kind: "offer", sdp: "v=0", message: "sneaky" },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts publish_ephemeral_key without plaintext", () => {
    const result = parseClientMessage({
      type: "publish_ephemeral_key",
      sessionId: validSession,
      keyId: validSession,
      encryptedKeyMaterial: "base64ciphertext==",
      expiresAt: Date.now() + 60_000,
      singleUse: true,
    });
    expect(result.ok).toBe(true);
  });
});
