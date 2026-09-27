import { describe, expect, it } from "vitest";
import { auditOutbound, ServerInterface } from "./index.js";
import type { ClientToServerMessage } from "@ztc/protocol";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const peerId = "abcdef0123456789abcdef0123456789";

describe("auditOutbound", () => {
  it("allows valid register_session", () => {
    expect(() =>
      auditOutbound({
        type: "register_session",
        sessionId,
        peerId,
        expiresAt: Date.now() + 1000,
      }),
    ).not.toThrow();
  });

  it("blocks plaintext field injection", () => {
    const sneaky = {
      type: "signalling",
      sessionId,
      fromPeerId: peerId,
      toPeerId: peerId,
      payload: { kind: "offer", sdp: "v=0" },
      plaintext: "hello",
    } as unknown as ClientToServerMessage;
    expect(() => auditOutbound(sneaky)).toThrow(/Unexpected field|Forbidden/);
  });

  it("blocks privateKey field in nested JSON if present as key", () => {
    const sneaky = {
      type: "relay_packet",
      sessionId,
      fromPeerId: peerId,
      toPeerId: peerId,
      opaquePayload: "abc",
      privateKey: "deadbeef",
    } as unknown as ClientToServerMessage;
    expect(() => auditOutbound(sneaky)).toThrow();
  });
});

describe("ServerInterface API surface", () => {
  it("exposes only the auditable methods", () => {
    const si = new ServerInterface({ url: "ws://localhost:8787" });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(si)).filter(
      (m) => m !== "constructor",
    );
    // Must NOT have message/contact APIs
    expect(methods).not.toContain("sendMessage");
    expect(methods).not.toContain("storeContact");
    expect(methods).not.toContain("uploadHistory");
    expect(methods).not.toContain("sendPlaintext");
    // Required public surface
    for (const required of [
      "connect",
      "disconnect",
      "registerEphemeralSession",
      "requestPeer",
      "sendSignallingMessage",
      "publishPresence",
      "publishEphemeralKey",
      "retrieveEphemeralKey",
      "closeSession",
    ]) {
      expect(methods).toContain(required);
    }
  });
});
