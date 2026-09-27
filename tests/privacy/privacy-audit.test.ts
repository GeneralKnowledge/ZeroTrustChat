import { describe, expect, it } from "vitest";
import { generateIdentity } from "@ztc/crypto";
import {
  ALLOWED_CLIENT_FIELDS,
  FORBIDDEN_FIELD_NAMES,
  FORBIDDEN_TYPES,
  parseClientMessage,
  type ClientToServerMessage,
} from "@ztc/protocol";
import { auditOutbound, ServerInterface } from "@ztc/server-interface";
import {
  assertNoPlaintextChat,
  assertNoPrivateKeys,
  assertPrivacyBoundary,
} from "@ztc/test-utils";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";

describe("privacy audit suite", () => {
  it("plaintext messages never cross server interface", () => {
    const outbound: ClientToServerMessage[] = [
      {
        type: "register_session",
        sessionId,
        peerId: "peer-aaaaaaaaaaaaaaaa",
        expiresAt: Date.now() + 1000,
      },
      {
        type: "signalling",
        sessionId,
        fromPeerId: "peer-aaaaaaaaaaaaaaaa",
        toPeerId: "peer-bbbbbbbbbbbbbbbb",
        payload: { kind: "offer", sdp: "v=0" },
      },
    ];
    assertPrivacyBoundary(outbound);
    assertNoPlaintextChat(outbound, ["Meet me at 8", "hello alice"]);
  });

  it("private keys never cross server interface", () => {
    const id = generateIdentity();
    const outbound: ClientToServerMessage[] = [
      {
        type: "publish_ephemeral_key",
        sessionId,
        keyId: sessionId,
        encryptedKeyMaterial: "aabbccdd11223344",
        expiresAt: Date.now() + 1000,
        singleUse: true,
      },
    ];
    assertPrivacyBoundary(outbound);
    assertNoPrivateKeys(outbound, [id.privateKey]);
  });

  it("contact lists never cross server interface", () => {
    for (const type of FORBIDDEN_TYPES) {
      const result = parseClientMessage({ type, contacts: [{ name: "Bob" }] });
      expect(result.ok).toBe(false);
    }
    for (const field of ["contacts", "contactList"] as const) {
      expect(FORBIDDEN_FIELD_NAMES).toContain(field);
    }
  });

  it("message history never crosses server interface", () => {
    const result = parseClientMessage({
      type: "upload_history",
      messages: [{ text: "old" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden_operation");
  });

  it("attachment plaintext never crosses server interface", () => {
    expect(FORBIDDEN_FIELD_NAMES).toContain("attachmentPlaintext");
    const sneaky = {
      type: "relay_packet",
      sessionId,
      fromPeerId: "peer-aaaaaaaaaaaaaaaa",
      toPeerId: "peer-bbbbbbbbbbbbbbbb",
      opaquePayload: "deadbeef",
      attachmentPlaintext: "photo-bytes",
    } as unknown as ClientToServerMessage;
    expect(() => auditOutbound(sneaky)).toThrow();
  });

  it("server protocol rejects unknown fields and operations", () => {
    expect(
      parseClientMessage({
        type: "register_session",
        sessionId,
        peerId: "peer-aaaaaaaaaaaaaaaa",
        expiresAt: 1,
        extra: true,
      }).ok,
    ).toBe(false);
    expect(parseClientMessage({ type: "not_a_real_op" }).ok).toBe(false);
  });

  it("allowed field map is frozen allowlist (guards API expansion)", () => {
    const types = Object.keys(ALLOWED_CLIENT_FIELDS).sort();
    expect(types).toEqual(
      [
        "close_session",
        "get_stats",
        "hello",
        "intro_claim",
        "intro_join",
        "intro_relay",
        "intro_release",
        "presence",
        "publish_ephemeral_key",
        "register_session",
        "relay_packet",
        "request_peer",
        "retrieve_ephemeral_key",
        "signalling",
      ].sort(),
    );
  });

  it("ServerInterface has no message/contact upload methods", () => {
    const proto = Object.getOwnPropertyNames(ServerInterface.prototype);
    expect(proto).not.toContain("sendMessage");
    expect(proto).not.toContain("uploadHistory");
    expect(proto).not.toContain("storeContact");
    expect(proto).not.toContain("sendPlaintext");
  });
});
